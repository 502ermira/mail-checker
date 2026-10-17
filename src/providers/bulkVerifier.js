import { ProviderError } from './mailVerifier.js';

const BASE = () => String(process.env.BULK_API_BASE || '').replace(/\/+$/, '');
const isMock = () => process.env.MOCK_PROVIDER === '1';

const bulkType = (key) => process.env[`BULK_TYPE_${key.toUpperCase()}`];

const TLD = '(?:com|[a-z]{2}|co\\.[a-z]{2}|com\\.[a-z]{2})';
const OUTLOOK_RE = new RegExp(`^(?:outlook|hotmail|live|msn)\\.${TLD}$`);
const YAHOO_RE = new RegExp(`^yahoo\\.${TLD}$`);

export function bulkTypeFor(email) {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  if (OUTLOOK_RE.test(domain)) return 'outlook';
  if (YAHOO_RE.test(domain) || domain === 'ymail.com' || domain === 'rocketmail.com') return 'yahoo';
  if (['mail.ru', 'inbox.ru', 'list.ru', 'bk.ru'].includes(domain)) return 'mailru';
  return null;
}

const ACCOUNT_PROBLEM_RE = /balance|point|credit|insufficient|password|account|auth|login|余额|不足|积分|密码|账号|账户|用户/i;

async function post(endpoint, fields = {}, file = null) {
  const form = new FormData();
  form.set('account', process.env.BULK_ACCOUNT || '');
  form.set('pass', process.env.BULK_PASS || '');
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  if (file) form.set('file', new Blob([file.content], { type: 'text/plain' }), file.name);

  let res;
  try {
    res = await fetch(`${BASE()}/${endpoint}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(file ? 120_000 : 30_000),
    });
  } catch {
    throw new ProviderError('bulk_unreachable');
  }
  if (!res.ok) throw new ProviderError(`bulk_http_${res.status}`);
  return res.text();
}

function unwrap(text) {
  if (process.env.LOG_PROVIDER_RAW === '1') console.log('[bulk raw]', text.slice(0, 4000));
  let data;
  try { data = JSON.parse(text); } catch { throw new ProviderError('bulk_bad_json'); }
  if (String(data?.RES) !== '100') {
    const err = String(data?.ERR || '');
    throw new ProviderError(`bulk_error_${data?.RES}: ${err}`, {
      retryable: false,
      alertAdmin: ACCOUNT_PROBLEM_RE.test(err),
    });
  }
  return data.DATA || {};
}

const EMAIL_IN_LINE = /[^\s,;:|"'<>]+@[^\s,;:|"'<>]+\.[^\s,;:|"'<>]{2,}/;
function parseList(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(EMAIL_IN_LINE);
    if (m) out.push(m[0].toLowerCase());
  }
  return out;
}

// ---------- mock mode (MOCK_PROVIDER=1) ----------

const mockJobs = new Map();
let mockSeq = 1000;
function mockActivated(email) {
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 3 !== 0;
}

// ---------- public API ----------

export async function bulkBalance() {
  if (isMock()) return { balance1: 999999, balance2: 0, total: 999999 };
  const d = unwrap(await post('Balance.ashx'));
  const balance1 = Number(d.balance1) || 0;
  const balance2 = Number(d.balance2) || 0;
  return { balance1, balance2, total: balance1 + balance2 };
}

export async function bulkUpload(typeKey, emails) {
  if (isMock()) {
    if (emails.length < Number(process.env.BULK_MIN_PER_FILE || 2001))
      throw new ProviderError(`bulk_error_104: email count must be greater than 2000 [${emails.length}]`);
    const id = String(++mockSeq);
    mockJobs.set(id, { emails, readyAt: Date.now() + Number(process.env.MOCK_BULK_DELAY_MS || 5000) });
    return id;
  }
  const d = unwrap(
    await post(
      'UploadEmail.ashx',
      { code: process.env.BULK_COUNTRY_CODE || '1', type: bulkType(typeKey) },
      { name: 'emails.txt', content: emails.join('\n') }
    )
  );
  if (!d.sendID) throw new ProviderError('bulk_no_send_id');
  return String(d.sendID);
}

export async function bulkQuery(sendID) {
  if (isMock()) {
    const j = mockJobs.get(sendID);
    if (!j) throw new ProviderError('bulk_unknown_send_id');
    if (Date.now() < j.readyAt) return { done: false, activated: 0, unregistered: 0 };
    const activated = j.emails.filter(mockActivated).length;
    return { done: true, activated, unregistered: j.emails.length - activated };
  }
  const d = unwrap(await post('Query.ashx', { sendID }));
  return {
    done: String(d.status) === '2',
    activated: Number(d.number2) || 0,
    unregistered: Number(d.number3) || 0,
  };
}

export async function bulkDownload(sendID, kind) {
  if (isMock()) {
    const j = mockJobs.get(sendID);
    return j.emails.filter((e) => mockActivated(e) === (kind === 'activated'));
  }
  const text = await post('Download.ashx', { sendID, type: kind === 'activated' ? 2 : 3 });
  if (text.trimStart().startsWith('{')) {
    unwrap(text);
    throw new ProviderError('bulk_unexpected_json_download');
  }
  return parseList(text);
}