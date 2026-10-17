import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import db from './db.js';
import { getBalance, addCredits, spendCredits } from './credits.js';
import { providerCredits } from './providers/mailVerifier.js';
import { bulkBalance } from './providers/bulkVerifier.js';
import { checkEmail, startWorker } from './worker.js';
import { registerJobRoutes } from './jobRoutes.js';
import { registerBillingRoutes } from './billingRoutes.js';
import { startRetention } from './retention.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me') {
  console.error('Set a real JWT_SECRET in your .env file.');
  process.exit(1);
}

if (process.env.MOCK_PROVIDER !== '1' && (!process.env.BULK_ACCOUNT || !process.env.BULK_PASS)) {
  console.error('Set BULK_ACCOUNT and BULK_PASS in your .env file.');
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
  res.json({ username: req.user.email, isAdmin: !!req.user.is_admin, credits: getBalance(req.user.id) });
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

app.post('/api/admin/grant', requireAuth, requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const amount = parseInt(req.body.amount, 10);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000)
    return res.status(400).json({ error: 'Amount must be a whole number.' });
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(username);
  if (!user) return res.status(404).json({ error: 'No user with that username.' });
  addCredits(user.id, amount, 'manual_grant', `by:${req.user.email}`);
  res.json({ ok: true, credits: getBalance(user.id) });
});

app.get('/api/admin/provider-credits', requireAuth, requireAdmin, async (req, res) => {
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
});