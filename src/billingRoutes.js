import rateLimit from 'express-rate-limit';
import { getBalance } from './credits.js';
import { PLANS, CURRENCY, getPlan } from './plans.js';
import { createOrder, fulfillOrder, failOrder, setProviderRef, listOrders } from './billing.js';
import { paymentsAvailable, createCheckout, isTestMode } from './payments.js';

const purchaseLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10 });

export function registerBillingRoutes(app, requireAuth) {
  app.get('/api/plans', (req, res) => {
    res.json({
      testMode: isTestMode(),
      plans: PLANS.map((p) => ({ ...p, currency: CURRENCY })),
    });
  });

  app.post('/api/purchase', requireAuth, purchaseLimiter, async (req, res) => {
    const plan = getPlan(String(req.body.planId || ''));
    if (!plan) return res.status(400).json({ error: 'Unknown plan.' });
    if (!paymentsAvailable()) return res.status(503).json({ error: 'Purchases are not available right now.' });

    const order = createOrder(req.user.id, plan, process.env.PAYMENT_PROVIDER || 'test');
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
}