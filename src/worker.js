import db from './db.js';
import { addCredits } from './credits.js';
import { verify, ProviderError } from './providers/mailVerifier.js';

const concurrency = () => Math.max(1, Number(process.env.JOB_CONCURRENCY || 3));
const cacheMs = () => Number(process.env.CACHE_DAYS ?? 30) * 24 * 3600 * 1000;
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
  db.prepare("UPDATE job_items SET state = 'cancelled' WHERE job_id = ? AND state = 'pending'").run(jobId);
  db.prepare('UPDATE jobs SET status = ?, refunded = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(finalStatus, refund, jobId);
  return true;
});

async function processItem(item) {
  try {
    const r = await checkEmail(item.email);
    db.prepare("UPDATE job_items SET state = 'done', result = ?, charged = ? WHERE id = ?")
      .run(r.status, r.charged ? 1 : 0, item.id);
  } catch (e) {
    if (e instanceof ProviderError && e.alertAdmin) {
      pausedUntil = Date.now() + 60_000;
      console.error(`!!! ACTION NEEDED (${e.message}). Worker paused for 60s. Jobs keep their place.`);
      return; 
    }
    if (e.message === 'provider_rate_limited') { pausedUntil = Date.now() + 15_000; return; }

    pausedUntil = Math.max(pausedUntil, Date.now() + 2_000);
    const attempts = item.attempts + 1;
    console.error('item error:', e.message);
    if (attempts >= 3) db.prepare("UPDATE job_items SET state = 'error', attempts = ? WHERE id = ?").run(attempts, item.id);
    else db.prepare('UPDATE job_items SET attempts = ? WHERE id = ?').run(attempts, item.id);
  }
}

async function tick() {
  if (Date.now() < pausedUntil) return false;

  const job = db.prepare(`SELECT id FROM jobs WHERE status IN ('queued','running') ORDER BY last_served, id LIMIT 1`).get();
  if (!job) return false;
  db.prepare("UPDATE jobs SET status = 'running', last_served = ? WHERE id = ?").run(Date.now(), job.id);

  const items = db.prepare(`SELECT id, email, attempts FROM job_items WHERE job_id = ? AND state = 'pending' ORDER BY id LIMIT ?`)
    .all(job.id, concurrency());
  if (!items.length) { finishJob(job.id, 'done'); return true; }

  await Promise.all(items.map(processItem));
  return true;
}

export function startWorker() {
  if (started) return;
  started = true;
  const loop = async () => {
    let worked = false;
    try { worked = await tick(); } catch (e) { console.error('worker error:', e); }
    setTimeout(loop, worked ? 0 : 1000);
  };
  loop();
  console.log(`Worker started: ${concurrency()} emails at a time.`);
}