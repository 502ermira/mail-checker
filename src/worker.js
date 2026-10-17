import db from './db.js';
import { addCredits } from './credits.js';
import { verify, ProviderError } from './providers/mailVerifier.js';
import { bulkBalance, bulkUpload, bulkQuery, bulkDownload } from './providers/bulkVerifier.js';

const cacheMs = () => Number(process.env.CACHE_DAYS ?? 30) * 24 * 3600 * 1000;
const pollMs = () => Number(process.env.BULK_POLL_SECONDS || 15) * 1000;
const maxWaitMs = () => Number(process.env.BULK_MAX_WAIT_HOURS || 6) * 3600 * 1000;
const MAX_UPLOAD_ATTEMPTS = 3;
const minPerFile = () => Number(process.env.BULK_MIN_PER_FILE || 2001);
const costPerEmail = () => Number(process.env.BULK_COST_PER_EMAIL || 0);
const DEFINITIVE = new Set(['valid', 'invalid', 'catch_all']);

let pausedUntil = 0;
let started = false;

export async function checkEmail(email) {
  if (cacheMs() > 0) {
    const hit = db.prepare('SELECT status FROM result_cache WHERE email = ? AND checked_at > ?')
      .get(email, Date.now() - cacheMs());
    if (hit) return { status: hit.status, charged: true, cached: true };
  }
  const r = await verify(email);
  if (cacheMs() > 0 && DEFINITIVE.has(r.status)) {
    db.prepare('INSERT OR REPLACE INTO result_cache (email, status, checked_at) VALUES (?, ?, ?)')
      .run(email, r.status, Date.now());
  }
  return r;
}

export const finishJob = db.transaction((jobId, finalStatus) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || !['queued', 'running'].includes(job.status)) return false;

  const refund = db.prepare(`
    SELECT COUNT(*) AS c FROM job_items
    WHERE job_id = ? AND (state IN ('error', 'pending') OR (state = 'done' AND charged = 0))
  `).get(jobId).c;

  if (refund > 0) addCredits(job.user_id, refund, 'job_refund', `job:${jobId}`);
  db.prepare("UPDATE job_batches SET status = 'cancelled' WHERE job_id = ? AND status = 'new'").run(jobId);
  db.prepare("UPDATE job_items SET state = 'cancelled' WHERE job_id = ? AND state = 'pending'").run(jobId);
  db.prepare('UPDATE jobs SET status = ?, refunded = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(finalStatus, refund, jobId);
  return true;
});

function completeIfFinished(jobId) {
  const open = db.prepare(
    "SELECT 1 FROM job_batches WHERE job_id = ? AND status IN ('new', 'submitting', 'submitted')"
  ).get(jobId);
  if (!open) finishJob(jobId, 'done');
}

const failBatch = db.transaction((batchId, reason) => {
  console.error(`bulk batch ${batchId} failed: ${reason}`);
  db.prepare("UPDATE job_items SET state = 'error' WHERE batch_id = ? AND state = 'pending'").run(batchId);
  db.prepare("UPDATE job_batches SET status = 'failed' WHERE id = ?").run(batchId);
});

const requeueBatch = (batchId, attempts) =>
  db.prepare("UPDATE job_batches SET status = 'new', attempts = ? WHERE id = ?").run(attempts, batchId);

async function submitBatch(batch) {
  db.prepare("UPDATE job_batches SET status = 'submitting' WHERE id = ?").run(batch.id);

  const items = db.prepare("SELECT id, email FROM job_items WHERE batch_id = ? AND state = 'pending'").all(batch.id);

  let toSend = items;
  if (cacheMs() > 0) {
    const cutoff = Date.now() - cacheMs();
    const get = db.prepare('SELECT status FROM result_cache WHERE email = ? AND checked_at > ?');
    const hits = [];
    const rest = [];
    for (const it of items) {
      const hit = get.get(it.email, cutoff);
      if (hit) hits.push([hit.status, it.id]); else rest.push(it);
    }
    if (rest.length === 0 || rest.length >= minPerFile()) {
      const mark = db.prepare("UPDATE job_items SET state = 'done', result = ?, charged = 1 WHERE id = ?");
      db.transaction(() => { for (const [status, id] of hits) mark.run(status, id); })();
      toSend = rest;
    }
  }

  if (!toSend.length) {
    db.prepare("UPDATE job_batches SET status = 'done' WHERE id = ?").run(batch.id);
    return;
  }

  try {
    if (costPerEmail() > 0) {
      const bal = await bulkBalance();
      const need = toSend.length * costPerEmail();
      if (bal.total < need) {
        pausedUntil = Date.now() + 60_000;
        console.error(`!!! ACTION NEEDED: bulk provider balance is ${bal.total}, this batch needs about ${need}. Worker paused for 60s. Jobs keep their place.`);
        requeueBatch(batch.id, batch.attempts);
        return;
      }
    }

    const sendId = await bulkUpload(batch.type, toSend.map((i) => i.email));
    const now = Date.now();
    db.prepare("UPDATE job_batches SET status = 'submitted', send_id = ?, submitted_at = ?, last_polled = ? WHERE id = ?")
      .run(sendId, now, now, batch.id);
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ? AND status = 'queued'").run(batch.job_id);
  } catch (e) {
    if (e instanceof ProviderError && e.alertAdmin) {
      pausedUntil = Date.now() + 60_000;
      console.error(`!!! ACTION NEEDED (${e.message}). Worker paused for 60s. Jobs keep their place.`);
      requeueBatch(batch.id, batch.attempts);
      return;
    }
    const attempts = batch.attempts + 1;
    console.error('bulk upload error:', e.message);
    if (attempts >= MAX_UPLOAD_ATTEMPTS) failBatch(batch.id, e.message);
    else { requeueBatch(batch.id, attempts); pausedUntil = Date.now() + 5_000 * attempts; }
  }
}

const applyResults = db.transaction((batch, activated, unregistered) => {
  const act = new Set(activated);
  const unreg = new Set(unregistered);
  const items = db.prepare("SELECT id, email FROM job_items WHERE batch_id = ? AND state = 'pending'").all(batch.id);

  const done = db.prepare("UPDATE job_items SET state = 'done', result = ?, charged = 1 WHERE id = ?");
  const missing = db.prepare("UPDATE job_items SET state = 'error' WHERE id = ?");
  const cache = db.prepare('INSERT OR REPLACE INTO result_cache (email, status, checked_at) VALUES (?, ?, ?)');

  for (const it of items) {
    const result = act.has(it.email) ? 'valid' : unreg.has(it.email) ? 'invalid' : null;
    if (result) {
      done.run(result, it.id);
      if (cacheMs() > 0) cache.run(it.email, result, Date.now());
    } else {
      missing.run(it.id);
    }
  }
  db.prepare("UPDATE job_batches SET status = 'done' WHERE id = ?").run(batch.id);
});

async function pollBatch(batch) {
  db.prepare('UPDATE job_batches SET last_polled = ? WHERE id = ?').run(Date.now(), batch.id);
  const expired = Date.now() - batch.submitted_at > maxWaitMs();

  try {
    const q = await bulkQuery(batch.send_id);
    if (!q.done) {
      if (expired) failBatch(batch.id, 'timed_out_waiting_for_provider');
      return;
    }
    const activated = q.activated > 0 ? await bulkDownload(batch.send_id, 'activated') : [];
    const unregistered = q.unregistered > 0 ? await bulkDownload(batch.send_id, 'unregistered') : [];
    if (activated.length !== q.activated || unregistered.length !== q.unregistered)
      console.error(`bulk batch ${batch.id}: provider counted ${q.activated}/${q.unregistered} but files parsed to ${activated.length}/${unregistered.length}`);
    applyResults(batch, activated, unregistered);
  } catch (e) {
    console.error('bulk poll error:', e.message);
    if (e instanceof ProviderError && e.alertAdmin) pausedUntil = Date.now() + 60_000;
    if (expired) failBatch(batch.id, `timed_out (${e.message})`);
  }
}

async function tick() {
  if (Date.now() < pausedUntil) return false;

  const activeJob = "j.status IN ('queued', 'running')";

  const next = db.prepare(`
    SELECT b.* FROM job_batches b JOIN jobs j ON j.id = b.job_id
    WHERE b.status = 'new' AND ${activeJob} ORDER BY b.id LIMIT 1
  `).get();
  if (next) {
    await submitBatch(next);
    completeIfFinished(next.job_id);
    return true;
  }

  const due = db.prepare(`
    SELECT b.* FROM job_batches b JOIN jobs j ON j.id = b.job_id
    WHERE b.status = 'submitted' AND b.last_polled <= ? AND ${activeJob} ORDER BY b.last_polled LIMIT 1
  `).get(Date.now() - pollMs());
  if (due) {
    await pollBatch(due);
    completeIfFinished(due.job_id);
    return true;
  }
  return false;
}

export function startWorker() {
  if (started) return;
  started = true;
  db.prepare("UPDATE job_batches SET status = 'new' WHERE status = 'submitting'").run();

  const loop = async () => {
    let worked = false;
    try { worked = await tick(); } catch (e) { console.error('worker error:', e); }
    setTimeout(loop, worked ? 0 : 1000);
  };
  loop();
  console.log('Worker started (bulk batches, polling every ' + pollMs() / 1000 + 's).');
}