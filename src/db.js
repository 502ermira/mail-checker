import Database from 'better-sqlite3';

const db = new Database(process.env.DB_PATH || 'data.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  ref        TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id);

CREATE TABLE IF NOT EXISTS checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  email      TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_checks_user ON checks(user_id);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  filename    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | cancelled
  total       INTEGER NOT NULL,
  refunded    INTEGER NOT NULL DEFAULT 0,
  last_served INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);

CREATE TABLE IF NOT EXISTS job_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id   INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  email    TEXT NOT NULL,
  state    TEXT NOT NULL DEFAULT 'pending',     -- pending | done | error | cancelled
  result   TEXT,                                -- valid | invalid | catch_all | unknown | bad_format
  charged  INTEGER NOT NULL DEFAULT 0,          -- 1 = this result keeps its credit
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_job_state ON job_items(job_id, state);

CREATE TABLE IF NOT EXISTS result_cache (
  email      TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);

-- One row per file sent to the bulk provider (one provider type per file).
CREATE TABLE IF NOT EXISTS job_batches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,                    -- gmail | outlook | yahoo | mailru
  status       TEXT NOT NULL DEFAULT 'new',      -- new | submitting | submitted | done | failed | cancelled
  send_id      TEXT,                             -- provider's sendID
  attempts     INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER,
  last_polled  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_batches_job ON job_batches(job_id, status);
`);

const itemCols = db.prepare('PRAGMA table_info(job_items)').all().map((c) => c.name);
if (!itemCols.includes('batch_id'))
  db.exec('ALTER TABLE job_items ADD COLUMN batch_id INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_items_batch ON job_items(batch_id, state)');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  plan_id      TEXT NOT NULL,
  credits      INTEGER NOT NULL,
  price_cents  INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | failed
  provider     TEXT NOT NULL,
  provider_ref TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
`);

const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
if (!orderCols.includes('bonus_credits'))
  db.exec('ALTER TABLE orders ADD COLUMN bonus_credits INTEGER NOT NULL DEFAULT 0');


const oc = () => db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
if (!oc().includes('pay_amount')) db.exec('ALTER TABLE orders ADD COLUMN pay_amount INTEGER');
if (!oc().includes('expires_at')) db.exec('ALTER TABLE orders ADD COLUMN expires_at INTEGER');
if (!oc().includes('tx_id')) db.exec('ALTER TABLE orders ADD COLUMN tx_id TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tx ON orders(tx_id) WHERE tx_id IS NOT NULL');
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pending_amount ON orders(pay_amount) WHERE status = 'pending'");

export default db;