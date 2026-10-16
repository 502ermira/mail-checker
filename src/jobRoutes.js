import db from './db.js';
import { getBalance, spendCredits } from './credits.js';
import { extractEmails, csvCell } from './csv.js';
import { finishJob } from './worker.js';
import { bulkTypeFor } from './providers/bulkVerifier.js';

const MAX_EMAILS = () => Number(process.env.MAX_JOB_EMAILS || 100000);
const MAX_PER_FILE = () => Number(process.env.BULK_MAX_PER_FILE || 50000);
const MIN_PER_FILE = () => Number(process.env.BULK_MIN_PER_FILE || 2001);

const NAMES = { gmail: 'Gmail', outlook: 'Outlook/Hotmail', yahoo: 'Yahoo', mailru: 'Mail.ru' };

function groupEmails(valid) {
  const byType = {};
  const unsupported = [];
  for (const e of valid) {
    const t = bulkTypeFor(e);
    if (t) (byType[t] ||= []).push(e); else unsupported.push(e);
  }
  const counts = Object.fromEntries(Object.entries(byType).map(([t, l]) => [t, l.length]));
  const tooSmall = [];
  for (const t of Object.keys(byType)) {
    if (byType[t].length < MIN_PER_FILE()) { tooSmall.push(...byType[t]); delete byType[t]; }
  }
  return { byType, unsupported, tooSmall, counts };
}

function chunk(list) {
  const size = Math.max(MAX_PER_FILE(), MIN_PER_FILE() * 2);
  const n = Math.ceil(list.length / size);
  const per = Math.ceil(list.length / n);
  const out = [];
  for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per));
  return out;
}

const createJob = db.transaction((userId, filename, groups, bad, total) => {
  const { lastInsertRowid: jobId } = db
    .prepare('INSERT INTO jobs (user_id, filename, total) VALUES (?, ?, ?)')
    .run(userId, filename, total);

  spendCredits(userId, total, 'job_reserve', `job:${jobId}`);

  const addBatch = db.prepare('INSERT INTO job_batches (job_id, type) VALUES (?, ?)');
  const addPending = db.prepare('INSERT INTO job_items (job_id, email, batch_id) VALUES (?, ?, ?)');
  const addDone = db.prepare("INSERT INTO job_items (job_id, email, state, result, charged) VALUES (?, ?, 'done', ?, 0)");

  for (const [type, list] of Object.entries(groups.byType)) {
    for (const part of chunk(list)) {
      const { lastInsertRowid: batchId } = addBatch.run(jobId, type);
      for (const e of part) addPending.run(jobId, e, batchId);
    }
  }
  for (const e of groups.unsupported) addDone.run(jobId, e, 'unknown');
  for (const e of groups.tooSmall) addDone.run(jobId, e, 'unknown');
  for (const e of bad) addDone.run(jobId, e, 'bad_format');

  return { jobId };
});

export function registerJobRoutes(app, requireAuth) {
  const ownJob = (req, res) => {
    const id = parseInt(req.params.id, 10);
    const job = Number.isInteger(id) && db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!job) { res.status(404).json({ error: 'Job not found.' }); return null; }
    return job;
  };

  app.post('/api/jobs', requireAuth, (req, res) => {
    const filename = String(req.body.filename || 'upload.csv').slice(0, 120);
    const text = String(req.body.csv || '');
    const { valid, bad, duplicates } = extractEmails(text);
    const total = valid.length + bad.length;

    if (total === 0) return res.status(400).json({ error: 'No email addresses found in this file.' });
    if (total > MAX_EMAILS())
      return res.status(400).json({ error: `Too many emails (${total.toLocaleString()}). The limit is ${MAX_EMAILS().toLocaleString()} per file.` });
    const groups = groupEmails(valid);
    if (!Object.keys(groups.byType).length) {
      const have = Object.entries(groups.counts).map(([t, c]) => `${NAMES[t]} ${c.toLocaleString()}`).join(', ');
      return res.status(400).json({
        error: have
          ? `Bulk checking needs more than ${(MIN_PER_FILE() - 1).toLocaleString()} addresses from the same provider (Gmail, Outlook/Hotmail, Yahoo or Mail.ru) in one file. This file has: ${have}.`
          : 'Bulk checking currently supports Gmail, Outlook/Hotmail, Yahoo and Mail.ru addresses. None were found in this file.',
      });
    }

    try {
      const { jobId } = createJob(req.user.id, filename, groups, bad, total);
      res.json({
        id: jobId,
        total,
        badFormat: bad.length,
        unsupported: groups.unsupported.length,
        tooSmall: groups.tooSmall.length,
        duplicatesRemoved: duplicates,
      });
    } catch (e) {
      if (e.message === 'INSUFFICIENT_CREDITS')
        return res.status(402).json({ error: `This file needs ${total.toLocaleString()} credits but you have ${getBalance(req.user.id).toLocaleString()}.` });
      throw e;
    }
  });

  app.get('/api/jobs', requireAuth, (req, res) => {
    const jobs = db.prepare(`
      SELECT j.id, j.filename, j.status, j.total, j.refunded, j.created_at, j.finished_at,
             (SELECT COUNT(*) FROM job_items i WHERE i.job_id = j.id AND i.state != 'pending') AS processed
      FROM jobs j WHERE j.user_id = ? ORDER BY j.id DESC LIMIT 20
    `).all(req.user.id);

    if (jobs.length) {
      const ids = jobs.map((j) => j.id);
      const rows = db.prepare(`
        SELECT job_id, COALESCE(result, state) AS r, COUNT(*) AS c FROM job_items
        WHERE job_id IN (${ids.map(() => '?').join(',')}) AND state != 'pending' GROUP BY job_id, r
      `).all(...ids);
      for (const j of jobs) j.counts = {};
      for (const r of rows) jobs.find((j) => j.id === r.job_id).counts[r.r] = r.c;
    }
    res.json(jobs);
  });

  app.post('/api/jobs/:id/cancel', requireAuth, (req, res) => {
    const job = ownJob(req, res); if (!job) return;
    const sent = db.prepare("SELECT 1 FROM job_batches WHERE job_id = ? AND status IN ('submitting', 'submitted')").get(job.id);
    if (sent) return res.status(409).json({ error: 'This file is already being checked and can no longer be cancelled.' });
    const ok = finishJob(job.id, 'cancelled');
    res.json({ ok, credits: getBalance(req.user.id) });
  });

  app.get('/api/jobs/:id/download', requireAuth, (req, res) => {
    const job = ownJob(req, res); if (!job) return;
    const items = db.prepare('SELECT email, state, result FROM job_items WHERE job_id = ? ORDER BY id').all(job.id);
    const label = (i) => i.state === 'done' ? i.result : i.state === 'error' ? 'not_verified_retry_later' : i.state === 'cancelled' ? 'not_checked' : 'pending';
    const body = 'email,result\n' + items.map((i) => `${csvCell(i.email)},${label(i)}`).join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="results-job-${job.id}.csv"`);
    res.send(body);
  });
}