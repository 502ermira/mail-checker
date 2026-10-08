import db from './db.js';

export function getBalance(userId) {
  return db
    .prepare('SELECT COALESCE(SUM(delta), 0) AS b FROM credit_ledger WHERE user_id = ?')
    .get(userId).b;
}

export function addCredits(userId, amount, reason, ref = null) {
  db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, ref) VALUES (?, ?, ?, ?)')
    .run(userId, amount, reason, ref);
}

export const spendCredits = db.transaction((userId, amount, reason, ref = null) => {
  if (getBalance(userId) < amount) throw new Error('INSUFFICIENT_CREDITS');
  addCredits(userId, -amount, reason, ref);
});
