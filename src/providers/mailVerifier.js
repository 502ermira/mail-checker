export const STATUSES = ['valid', 'invalid', 'catch_all', 'unknown', 'bad_format'];

const BASE = 'https://api.mail-verifier.xyz/';
const MAX_PER_MIN = Number(process.env.PROVIDER_MAX_PER_MIN || 600);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
async function throttle() {
  const gap = 60000 / MAX_PER_MIN;
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + gap;
  if (slot > now) await sleep(slot - now);
}

export class ProviderError extends Error {
  constructor(message, { retryable = true, alertAdmin = false } = {}) {
    super(message);
    this.retryable = retryable;
    this.alertAdmin = alertAdmin;
  }
}

export function normalize(data) {
  const code = Number(data?.code);
  const msg = String(data?.msg || '').toLowerCase();

  switch (code) {
    case 1:
      return { status: msg.includes('catch-all') ? 'catch_all' : 'valid', charged: true };
    case 0:
      return { status: 'invalid', charged: true };
    case -1:
      return { status: 'bad_format', charged: false };
    case -5:
      return { status: 'unknown', charged: false };
    case -2:
      throw new ProviderError('provider_network_error');
    case -6:
      throw new ProviderError('provider_rate_limited');
    case -3:
      throw new ProviderError('provider_out_of_credits', { retryable: false, alertAdmin: true });
    case -4:
      throw new ProviderError('provider_key_invalid', { retryable: false, alertAdmin: true });
    default:
      throw new ProviderError(`provider_unknown_code_${data?.code}`);
  }
}

export async function verify(email) {
  if (process.env.MOCK_PROVIDER === '1') {
    await sleep(Number(process.env.MOCK_DELAY_MS || 0));
    return mockVerify(email);
  }

  await throttle();
  const url = new URL(BASE);
  url.searchParams.set('cmd', 'verify');
  url.searchParams.set('key', process.env.PROVIDER_KEY);
  url.searchParams.set('email', email);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch {
    throw new ProviderError('provider_unreachable');
  }
  if (!res.ok) throw new ProviderError(`provider_http_${res.status}`);

  const text = await res.text();
  if (process.env.LOG_PROVIDER_RAW === '1') console.log('[provider raw]', text);
  let data;
  try { data = JSON.parse(text); } catch { throw new ProviderError('provider_bad_json'); }
  return normalize(data);
}

export async function providerCredits() {
  if (process.env.MOCK_PROVIDER === '1') return 999999;
  const url = new URL(BASE);
  url.searchParams.set('cmd', 'credits');
  url.searchParams.set('key', process.env.PROVIDER_KEY);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  return Number(data.credits);
}

function mockVerify(email) {
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const status = STATUSES[h % STATUSES.length];
  return { status, charged: status !== 'bad_format' && status !== 'unknown' };
}