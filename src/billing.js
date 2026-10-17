import db from './db.js';
import { addCredits } from './credits.js';
import { CURRENCY } from './plans.js';
import crypto from 'node:crypto';

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

export const createdMs = (o) => Date.parse(o.created_at.replace(' ', 'T') + 'Z');

export function countOpenOrders(userId) {
  return db.prepare("SELECT COUNT(*) AS c FROM orders WHERE user_id = ? AND status = 'pending'").get(userId).c;
}

export function createCryptoOrder(userId, purchase, expiryMinutes) {
  const insert = db.prepare(`
    INSERT INTO orders (user_id, plan_id, credits, bonus_credits, price_cents, currency, provider, pay_amount, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'tron', ?, ?)`);
  for (let i = 0; i < 30; i++) {
    const payAmount = purchase.priceCents * 10_000 + crypto.randomInt(1, 1000) * 100;
    try {
      const info = insert.run(userId, purchase.planId, purchase.totalCredits, purchase.bonusCredits,
        purchase.priceCents, CURRENCY, payAmount, Date.now() + expiryMinutes * 60_000);
      return Number(info.lastInsertRowid);
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  }
  throw new Error('NO_FREE_AMOUNT');
}

export function getCryptoOrder(userId, orderId) {
  const o = db.prepare(
    "SELECT id, status, credits, pay_amount, expires_at FROM orders WHERE id = ? AND user_id = ? AND provider = 'tron'"
  ).get(orderId, userId);
  if (!o) return null;
  return {
    id: o.id, status: o.status, credits: o.credits,
    amount: (o.pay_amount / 1e6).toFixed(4),
    expiresAt: o.expires_at,
    address: process.env.TRON_ADDRESS,
  };
}

export const fulfillCryptoOrder = db.transaction((orderId, txId) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND provider = 'tron'").get(orderId);
  if (!order || order.status !== 'pending') return false;
  db.prepare("UPDATE orders SET status = 'paid', tx_id = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(txId, orderId);
  addCredits(order.user_id, order.credits, 'purchase', `order:${orderId}`);
  return true;
});

export const approveOrderManually = db.transaction((orderId, txId, credits) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new Error('NOT_FOUND');
  if (!['pending', 'expired'].includes(o.status)) throw new Error('NOT_APPROVABLE');

  const amount = credits ?? o.credits;
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10_000_000) throw new Error('BAD_CREDITS');

  db.prepare("UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP, tx_id = ?, credits = ? WHERE id = ?")
    .run(txId, amount, orderId);
  addCredits(o.user_id, amount, 'purchase', `order:${orderId}`);
  return { userId: o.user_id, credits: amount };
});