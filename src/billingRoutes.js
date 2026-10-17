import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import { getBalance } from './credits.js';
import { PLANS, CUSTOM, CURRENCY, resolvePurchase } from './plans.js';
import {
  createOrder, fulfillOrder, failOrder, setProviderRef, listOrders,
  createCryptoOrder, getCryptoOrder, countOpenOrders,
} from './billing.js';
import { paymentsAvailable, createCheckout, isTestMode, isCrypto } from './payments.js';

const purchaseLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10 });

let qrCache = null;
async function addressQr() {
  qrCache ??= await QRCode.toDataURL(process.env.TRON_ADDRESS, { margin: 1, width: 240 });
  return qrCache;
}

export function registerBillingRoutes(app, requireAuth) {
  app.get('/api/plans', (req, res) => {
    res.json({
      testMode: isTestMode(),
      currency: CURRENCY,
      plans: PLANS.map((p) => ({ ...p, totalCredits: p.credits + p.bonusCredits })),
      custom: CUSTOM,
    });
  });

  app.post('/api/purchase', requireAuth, purchaseLimiter, async (req, res) => {
    const purchase = resolvePurchase(String(req.body.planId || ''), req.body.amount);
    if (purchase.error) return res.status(400).json({ error: purchase.error });
    if (!paymentsAvailable()) return res.status(503).json({ error: 'Purchases are not available right now.' });

    if (isCrypto()) {
      if (countOpenOrders(req.user.id) >= 3)
        return res.status(429).json({ error: 'You have too many unpaid orders. Pay one or wait for it to expire.' });
      try {
        const id = createCryptoOrder(req.user.id, purchase, Number(process.env.ORDER_EXPIRY_MINUTES || 30));
        return res.json({ ok: true, crypto: { ...getCryptoOrder(req.user.id, id), qr: await addressQr() } });
      } catch (e) {
        console.error('crypto order error:', e.message);
        return res.status(503).json({ error: 'Could not create the payment request. Try again in a moment.' });
      }
    }

    const order = createOrder(req.user.id, purchase, process.env.PAYMENT_PROVIDER || 'test');
    try {
      const checkout = await createCheckout(order);
      if (checkout.paid) {
        fulfillOrder(order.id, checkout.providerRef);
        return res.json({ ok: true, added: order.credits, credits: getBalance(req.user.id) });
      }
      setProviderRef(order.id, checkout.providerRef);
      return res.json({ ok: true, redirectUrl: checkout.redirectUrl });
    } catch (e) {
      failOrder(order.id);
      console.error('checkout error:', e.message);
      res.status(502).json({ error: 'Could not start the payment. You were not charged.' });
    }
  });

  app.get('/api/orders', requireAuth, (req, res) => {
    res.json(listOrders(req.user.id));
  });

  app.get('/api/orders/:id', requireAuth, (req, res) => {
    const o = getCryptoOrder(req.user.id, parseInt(req.params.id, 10));
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    res.json(o);
  });
}