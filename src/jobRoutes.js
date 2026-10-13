import db from './db.js';
import { getBalance, spendCredits } from './credits.js';
import { extractEmails, csvCell } from './csv.js';
import { finishJob } from './worker.js';

const MAX_EMAILS = () => Number(process.env.MAX_JOB_EMAILS || 100000);

const createJob = db.transaction((userId, filename, valid, bad) => {
  const total = valid.length + bad.length;
  const { lastInsertRowid: jobId } = db
    .prepare('INSERT INTO jobs (user_id, filename, total) VALUES (?, ?, ?)')
    .run(userId, filename, total);

  spendCredits(userId, total, 'job_reserve', `job:${jobId}`);

  const addPending = db.prepare("INSERT INTO job_items (job_id, email) VALUES (?, ?)");
  const addBad = db.prepare("INSERT INTO job_items (job_id, email, state, result, charged) VALUES (?, ?, 'done', 'bad_format', 0)");
  for (const e of valid) addPending.run(jobId, e);
  for (const e of bad) addBad.run(jobId, e);
  return { jobId, total };
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

    try {
      const { jobId } = createJob(req.user.id, filename, valid, bad);
      res.json({ id: jobId, total, badFormat: bad.length, duplicatesRemoved: duplicates });
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
