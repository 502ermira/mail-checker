import db from './db.js';
import { fulfillCryptoOrder, createdMs } from './billing.js';

// Official USDT (TRC-20) contract
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const GRACE_MS = 10 * 60_000;

async function fetchIncoming(sinceMs) {
  const url = new URL(`https://api.trongrid.io/v1/accounts/${process.env.TRON_ADDRESS}/transactions/trc20`);
  url.searchParams.set('only_to', 'true');
  url.searchParams.set('only_confirmed', 'true');
  url.searchParams.set('contract_address', USDT);
  url.searchParams.set('min_timestamp', String(sinceMs));
  url.searchParams.set('order_by', 'block_timestamp,asc');
  url.searchParams.set('limit', '200');
  const headers = process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`trongrid_http_${res.status}`);
  const body = await res.json();
  return Array.isArray(body.data) ? body.data : [];
}

export async function checkPayments() {
  db.prepare("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND provider = 'tron' AND expires_at < ?")
    .run(Date.now() - GRACE_MS);

  const pending = db.prepare("SELECT id, pay_amount, expires_at, created_at FROM orders WHERE status = 'pending' AND provider = 'tron'").all();
  if (!pending.length) return;

  const txs = await fetchIncoming(Math.min(...pending.map(createdMs)));
  if (process.env.LOG_PAYMENT_RAW === '1') console.log('[tron raw]', JSON.stringify(txs).slice(0, 4000));

  const byAmount = new Map(pending.map((o) => [o.pay_amount, o]));
  for (const tx of txs) {
    if (tx.to !== process.env.TRON_ADDRESS) continue;
    if (tx.token_info?.address !== USDT) continue;
    const order = byAmount.get(Number(tx.value));
    if (!order) continue;
    if (tx.block_timestamp < createdMs(order) || tx.block_timestamp > order.expires_at) continue;
    try {
      if (fulfillCryptoOrder(order.id, tx.transaction_id))
        console.log(`payment: order ${order.id} paid by tx ${tx.transaction_id}`);
    } catch (e) {
      console.error('payment match error:', e.message);
    }
  }
}

let running = false;
export function startPaymentWatcher() {
  if (process.env.PAYMENT_PROVIDER !== 'tron') return;
  const run = async () => {
    if (running) return;
    running = true;
    try { await checkPayments(); }
    catch (e) { console.error('payment watcher error:', e.message); }
    finally { running = false; }
  };
  run();
  setInterval(run, 30_000).unref();
}