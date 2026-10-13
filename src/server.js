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
import { checkEmail, startWorker } from './worker.js';
import { registerJobRoutes } from './jobRoutes.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me') {
  console.error('Set a real JWT_SECRET in your .env file.');
  process.exit(1);
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use('/api/jobs', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
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

app.post('/api/signup', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'An account with this email already exists.' });

  const hash = await bcrypt.hash(password, 10);
  const isAdmin = email === (process.env.ADMIN_EMAIL || '').toLowerCase() ? 1 : 0;
  const info = db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)').run(email, hash, isAdmin);
  setSession(res, { id: info.lastInsertRowid });
  res.json({ ok: true });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Wrong email or password.' });
  setSession(res, user);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email, isAdmin: !!req.user.is_admin, credits: getBalance(req.user.id) });
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
    if (!charged) addCredits(req.user.id, 1, 'refund_not_charged', email); // free results are free for customers too
    db.prepare('INSERT INTO checks (user_id, email, status) VALUES (?, ?, ?)').run(req.user.id, email, status);
    res.json({ email, status, credits: getBalance(req.user.id) });
  } catch (e) {
    addCredits(req.user.id, 1, 'refund_provider_error', email); // customer never pays for our failures
    console.error('provider error:', e.message);
    if (e.alertAdmin) console.error('!!! ACTION NEEDED: top up or fix your provider account:', e.message);
    res.status(502).json({ error: 'Verification is temporarily unavailable. Your credit was refunded.' });
  }
});

registerJobRoutes(app, requireAuth);

app.get('/api/history', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT email, status, created_at FROM checks WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json(rows);
});

app.post('/api/admin/grant', requireAuth, requireAdmin, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const amount = parseInt(req.body.amount, 10);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000)
    return res.status(400).json({ error: 'Amount must be a whole number.' });
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'No user with that email.' });
  addCredits(user.id, amount, 'manual_grant', `by:${req.user.email}`);
  res.json({ ok: true, credits: getBalance(user.id) });
});

app.get('/api/admin/provider-credits', requireAuth, requireAdmin, async (req, res) => {
  try { res.json({ credits: await providerCredits() }); }
  catch { res.status(502).json({ error: 'Could not reach provider.' }); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Running on http://localhost:${port}`);
  startWorker();
});