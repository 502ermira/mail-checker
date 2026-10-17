import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import db from './db.js';
import { getBalance, addCredits, spendCredits } from './credits.js';
import { providerCredits } from './providers/mailVerifier.js';
import { bulkBalance } from './providers/bulkVerifier.js';
import { checkEmail, startWorker } from './worker.js';
import { registerJobRoutes } from './jobRoutes.js';
import { registerBillingRoutes } from './billingRoutes.js';
import { startRetention } from './retention.js';
import { startBackups } from './backup.js';
import { startPaymentWatcher } from './paymentWatcher.js';
import { approveOrderManually } from './billing.js';

const secret = process.env.JWT_SECRET || '';
if (secret.length < 32 || ['change-me', 'secret'].includes(secret)) {
  console.error('Set JWT_SECRET to a random string of at least 32 characters.');
  process.exit(1);
}

if (process.env.MOCK_PROVIDER !== '1') {
  for (const k of ['BULK_ACCOUNT', 'BULK_PASS', 'BULK_API_BASE', 'BULK_TYPE_FB', 'PROVIDER_KEY', 'PROVIDER_API_BASE']) {
    if (!process.env[k]) { console.error(`Set ${k} in your .env file.`); process.exit(1); }
  }
}

if (process.env.PAYMENT_PROVIDER === 'tron' && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(process.env.TRON_ADDRESS || '')) {
  console.error('Set a valid TRON_ADDRESS in your .env file.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use('/api/jobs', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 });

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

app.get('/assets/panel.js', (req, res) => {
  try {
    const { uid } = jwt.verify(req.cookies.session, process.env.JWT_SECRET);
    const u = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(uid);
    if (!u?.is_admin) throw new Error('no');
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript').sendFile(path.join(ROOT, 'private', 'panel.js'));
  } catch {
    res.status(404).end();
  }
});

const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 });

function keyMatches(given) {
  const key = process.env.ADMIN_KEY || '';
  if (key.length < 24) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

app.get('/admin/manage-users/cr', (req, res) => {
  res.sendFile(path.join(ROOT, 'admin', 'create-user.html'));
});

app.post('/api/setup/create-user', adminLimiter, async (req, res) => {
  if (!keyMatches(req.get('x-admin-key') || '')) return res.status(404).json({ error: 'Not found.' });

  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (username.length < 3 || username.length > 40)
    return res.status(400).json({ error: 'Username must be 3-40 characters.' });
  if (password.length < 8 || password.length > 72)
    return res.status(400).json({ error: 'Password must be 8-72 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(username))
    return res.status(409).json({ error: 'That username already exists.' });

  const hash = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(username, hash);
  res.json({ ok: true });
});

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

// NOTE: the database column is still called "email", but it now holds the USERNAME.
function requireAuth(req, res, next) {
  try {
    const { uid } = jwt.verify(req.cookies.session, process.env.JWT_SECRET);
    const user = db.prepare('SELECT id, email, is_admin FROM users WHERE id = ?').get(uid);
    if (!user) throw new Error('no user');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Please log in.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only.' });
  next();
}

app.post('/api/login', authLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Wrong username or password.' });
  setSession(res, user);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.post('/api/change-password', requireAuth, authLimiter, async (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  if (next.length > 72) return res.status(400).json({ error: 'New password is too long (72 characters max).' });
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!(await bcrypt.compare(current, row.password_hash)))
    return res.status(400).json({ error: 'Current password is wrong.' });
  const hash = await bcrypt.hash(next, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.email, tools: !!req.user.is_admin, credits: getBalance(req.user.id) });
});

app.post('/api/verify', requireAuth, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  try {
    spendCredits(req.user.id, 1, 'single_check', email);
  } catch (e) {
    if (e.message === 'INSUFFICIENT_CREDITS') return res.status(402).json({ error: 'Not enough credits.' });
    throw e;
  }

  try {
    const { status, charged } = await checkEmail(email);
    if (!charged) addCredits(req.user.id, 1, 'refund_not_charged', email);
    db.prepare('INSERT INTO checks (user_id, email, status) VALUES (?, ?, ?)').run(req.user.id, email, status);
    res.json({ email, status, credits: getBalance(req.user.id) });
  } catch (e) {
    addCredits(req.user.id, 1, 'refund_provider_error', email);
    console.error('provider error:', e.message);
    if (e.alertAdmin) console.error('!!! ACTION NEEDED: top up or fix your provider account:', e.message);
    res.status(502).json({ error: 'This check is temporarily unavailable. Your credit was refunded.' });
  }
});

registerJobRoutes(app, requireAuth);
registerBillingRoutes(app, requireAuth);

app.get('/api/history', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT email, status, created_at FROM checks WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json(rows);
});

app.get('/api/ledger', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT l.delta, l.reason, l.created_at,
           CASE
             WHEN l.reason IN ('single_check', 'refund_not_charged', 'refund_provider_error') THEN l.ref
             WHEN l.reason IN ('job_reserve', 'job_refund') THEN j.filename
           END AS detail
    FROM credit_ledger l
    LEFT JOIN jobs j ON l.ref = 'job:' || j.id AND j.user_id = l.user_id
    WHERE l.user_id = ? AND l.reason != 'carryover'
    ORDER BY l.id DESC LIMIT 200
  `).all(req.user.id);
  res.json(rows);
});

app.post('/api/ops/grant', requireAuth, requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const amount = parseInt(req.body.amount, 10);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000)
    return res.status(400).json({ error: 'Amount must be a whole number.' });
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(username);
  if (!user) return res.status(404).json({ error: 'No user with that username.' });
  addCredits(user.id, amount, 'manual_grant', `by:${req.user.email}`);
  res.json({ ok: true, credits: getBalance(user.id) });
});


app.get('/api/ops/orders', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT o.id, u.email AS username, o.credits, o.pay_amount, o.status, o.created_at
    FROM orders o JOIN users u ON u.id = o.user_id
    WHERE o.provider = 'tron' AND o.status IN ('pending', 'expired')
    ORDER BY o.id DESC LIMIT 50
  `).all();
  res.json(rows.map(({ pay_amount, ...r }) => ({ ...r, amount: (pay_amount / 1e6).toFixed(4) })));
});

app.post('/api/ops/orders/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const hash = String(req.body.txId || '').trim().toLowerCase();
  if (hash && !/^[0-9a-f]{64}$/.test(hash))
    return res.status(400).json({ error: 'A TRON transaction hash is 64 letters and numbers (0-9, a-f).' });
  const raw = req.body.credits;
  const credits = raw === '' || raw == null ? undefined : Number(raw);

  try {
    const r = approveOrderManually(id, hash || null, credits);
    console.log(`order ${id} approved manually by ${req.user.email}: ${r.credits} credits to user ${r.userId}`);
    res.json({ ok: true });
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'Order not found.' });
    if (e.message === 'NOT_APPROVABLE') return res.status(409).json({ error: 'This order is already paid or closed.' });
    if (e.message === 'BAD_CREDITS') return res.status(400).json({ error: 'Credits must be a whole number above 0.' });
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That transaction hash was already used on another order.' });
    throw e;
  }
});

app.get('/api/ops/provider-credits', requireAuth, requireAdmin, async (req, res) => {
  const [single, bulk] = await Promise.allSettled([providerCredits(), bulkBalance()]);
  if (single.status === 'rejected' && bulk.status === 'rejected')
    return res.status(502).json({ error: 'Could not reach provider.' });
  res.json({
    credits: single.status === 'fulfilled' ? single.value : null,
    bulk: bulk.status === 'fulfilled' ? bulk.value : null,
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Running on http://localhost:${port}`);
  startWorker();
  startRetention();
  startBackups();
  startPaymentWatcher();
});