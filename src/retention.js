import db from './db.js';

const JOB_DAYS = () => Number(process.env.JOB_RETENTION_DAYS || 7);
const HISTORY_DAYS = () => Number(process.env.HISTORY_RETENTION_DAYS || 30);

const cutoffText = (days) =>
  new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

const purgeLedger = db.transaction((cutoff) => {
  const old = db.prepare(`
    SELECT user_id, SUM(delta) AS total FROM credit_ledger
    WHERE reason != 'carryover' AND created_at < ?
    GROUP BY user_id
  `).all(cutoff);

  const find = db.prepare("SELECT id FROM credit_ledger WHERE user_id = ? AND reason = 'carryover'");
  const bump = db.prepare('UPDATE credit_ledger SET delta = delta + ? WHERE id = ?');
  const add = db.prepare("INSERT INTO credit_ledger (user_id, delta, reason, ref) VALUES (?, ?, 'carryover', NULL)");

  for (const { user_id, total } of old) {
    if (!total) continue;
    const existing = find.get(user_id);
    if (existing) bump.run(total, existing.id); else add.run(user_id, total);
  }
  return db.prepare("DELETE FROM credit_ledger WHERE reason != 'carryover' AND created_at < ?").run(cutoff).changes;
});

export function runRetention() {
  const history = cutoffText(HISTORY_DAYS());
  const jobs = cutoffText(JOB_DAYS());

  const jobsGone = db.prepare("DELETE FROM jobs WHERE status IN ('done', 'cancelled') AND created_at < ?").run(jobs).changes;
  const checksGone = db.prepare('DELETE FROM checks WHERE created_at < ?').run(history).changes;
  const ordersGone = db.prepare('DELETE FROM orders WHERE created_at < ?').run(history).changes;
  const ledgerGone = purgeLedger(history);
  const cacheGone = db.prepare('DELETE FROM result_cache WHERE checked_at < ?')
    .run(Date.now() - Number(process.env.CACHE_DAYS ?? 30) * 24 * 3600 * 1000).changes;

  if (jobsGone || checksGone || ordersGone || ledgerGone || cacheGone)
    console.log(`retention: removed ${jobsGone} jobs, ${checksGone} checks, ${ordersGone} orders, ${ledgerGone} credit entries, ${cacheGone} cached results`);
}

export function startRetention() {
  const safeRun = () => { try { runRetention(); } catch (e) { console.error('retention error:', e.message); } };
  safeRun();
  setInterval(safeRun, 60 * 60 * 1000).unref();
}