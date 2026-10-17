//node --env-file=.env src/approveOrder.js order_id TXHASHFROMTRONSCAN optional:300 (credits to give)
import db from './db.js';
import { addCredits } from './credits.js';

const [idArg, txArg, creditsArg] = process.argv.slice(2);
const id = parseInt(idArg, 10);
if (!Number.isInteger(id)) {
  console.error('Usage: node --env-file=.env src/approveOrder.js <orderId> [txHash|-] [credits]');
  process.exit(1);
}
const txId = txArg && txArg !== '-' ? txArg : null;

const approve = db.transaction(() => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) throw new Error('No such order.');
  if (!['pending', 'expired'].includes(o.status)) throw new Error(`Order is already "${o.status}".`);

  const credits = creditsArg ? parseInt(creditsArg, 10) : o.credits;
  if (!Number.isInteger(credits) || credits <= 0) throw new Error('Credits must be a positive whole number.');

  db.prepare("UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP, tx_id = ?, credits = ? WHERE id = ?")
    .run(txId, credits, id);
  addCredits(o.user_id, credits, 'purchase', `order:${id}`);
  return { user: o.user_id, credits };
});

try {
  const r = approve();
  console.log(`Order ${id} approved. User ${r.user} received ${r.credits} credits.`);
} catch (e) {
  console.error('Not approved:', e.message);
}