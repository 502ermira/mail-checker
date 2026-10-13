import db from './db.js';
import { addCredits } from './credits.js';
import { CURRENCY } from './plans.js';

export function createOrder(userId, purchase, provider) {
  const info = db.prepare(
    'INSERT INTO orders (user_id, plan_id, credits, bonus_credits, price_cents, currency, provider) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, purchase.planId, purchase.totalCredits, purchase.bonusCredits, purchase.priceCents, CURRENCY, provider);
  return { id: Number(info.lastInsertRowid), userId, credits: purchase.totalCredits };
}

export const fulfillOrder = db.transaction((orderId, providerRef = null) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'pending') return false;

  db.prepare("UPDATE orders SET status = 'paid', provider_ref = COALESCE(?, provider_ref), paid_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(providerRef, orderId);
  addCredits(order.user_id, order.credits, 'purchase', `order:${orderId}`);
  return true;
});

export function failOrder(orderId) {
  db.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'").run(orderId);
}

export function setProviderRef(orderId, ref) {
  db.prepare('UPDATE orders SET provider_ref = ? WHERE id = ?').run(ref, orderId);
}

export function listOrders(userId) {
  return db.prepare(
    'SELECT id, credits, bonus_credits, price_cents, currency, status, created_at FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 20'
  ).all(userId);
}