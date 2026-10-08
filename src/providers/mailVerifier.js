
const STATUSES = ['valid', 'invalid', 'catch_all', 'unknown', 'bad_format'];

export async function verify(email) {
  if (process.env.MOCK_PROVIDER === '1') return mockVerify(email);

  const url = new URL('https://api.mail-verifier.xyz/');
  url.searchParams.set('cmd', 'verify');
  url.searchParams.set('key', process.env.PROVIDER_KEY);
  url.searchParams.set('email', email);

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (res.status === 429) throw new Error('provider_rate_limited');
  if (!res.ok) throw new Error(`provider_http_${res.status}`);

  const text = await res.text();
  if (process.env.LOG_PROVIDER_RAW === '1') console.log('[provider raw]', text); // never log the URL: it has your key
  return normalize(text);
}

function normalize(text) {
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  console.warn('normalize() not implemented yet, returning "unknown". Raw:', data);
  return 'unknown';
}

function mockVerify(email) {
  const s = email.length % 5;
  return STATUSES[s];
}

export { STATUSES };
