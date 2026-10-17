const $ = (id) => document.getElementById(id);
const LABELS = { valid: 'Valid', invalid: 'Invalid', catch_all: 'Catch-all (can\'t confirm)', unknown: 'Unknown', bad_format: 'Bad format' };
const REASONS = {
  purchase: 'Credits purchased',
  single_check: 'Single check',
  job_reserve: 'Batch check',
  job_refund: 'Batch refund',
  refund_not_charged: 'Single check refund',
  refund_provider_error: 'Single check refund',
  manual_grant: 'Adjustment by support',
};

async function api(path, body) {
  const res = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function say(id, text, isErr) { const el = $(id); el.textContent = text; el.className = 'msg' + (isErr ? ' err' : ''); }

async function refresh() {
  try {
    const me = await api('me');
    $('auth').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('credits').textContent = me.credits.toLocaleString();
    $('accCredits').textContent = me.credits.toLocaleString();
    $('accEmail').textContent = me.username || '—';
    if (me.tools) loadTools(); else clearTools();
    const rows = await api('history');
    $('history').innerHTML = rows.length
      ? '<table><tr><th>Email</th><th>Result</th></tr>' + rows.map(r =>
          `<tr><td></td><td><span class="tag ${r.status}">${LABELS[r.status] || r.status}</span></td></tr>`).join('') + '</table>'
      : '<p class="empty">No checks yet. Enter an address above to run your first one.</p>';
    [...$('history').querySelectorAll('tr')].slice(1).forEach((tr, i) => tr.firstChild.textContent = rows[i].email);
    await Promise.all([loadOrders(), loadLedger()]);
  } catch {
    clearTools();
    $('auth').classList.remove('hidden');
    $('app').classList.add('hidden');
  }
}

async function login() {
  try {
    await api('login', { username: $('username').value, password: $('password').value });
    say('authMsg', '');
    $('password').value = '';
    await refresh();
    await refreshJobs();
  } catch (e) { say('authMsg', e.message, true); }
}
$('login').onclick = login;
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('logout').onclick = async () => { await api('logout', {}); await refresh(); };

$('changePass').onclick = async () => {
  const cur = $('curPass').value, next = $('newPass').value, again = $('newPass2').value;
  if (next !== again) return say('passMsg', 'The new passwords do not match.', true);
  try {
    await api('change-password', { currentPassword: cur, newPassword: next });
    $('curPass').value = ''; $('newPass').value = ''; $('newPass2').value = '';
    say('passMsg', 'Password changed.');
  } catch (e) { say('passMsg', e.message, true); }
};

$('check').onclick = async () => {
  say('checkMsg', 'Checking…');
  try {
    const r = await api('verify', { email: $('checkEmail').value });
    say('checkMsg', `${r.email}: ${LABELS[r.status] || r.status}`);
    await refresh();
  } catch (e) { say('checkMsg', e.message, true); }
};

let pollTimer = null;
const STATUS_TEXT = { queued: 'Waiting', running: 'Checking', done: 'Finished', cancelled: 'Cancelled' };

function renderJobs(jobs) {
  const box = $('jobs');
  box.textContent = '';
  if (!jobs.length) return;
  const table = document.createElement('table');
  table.innerHTML = '<tr><th>File</th><th>Progress</th><th>Results</th><th></th></tr>';
  for (const j of jobs) {
    const tr = document.createElement('tr');
    const pct = j.total ? Math.round((j.processed / j.total) * 100) : 0;

    const tdFile = document.createElement('td');
    tdFile.textContent = j.filename;

    const until = new Date(new Date(j.created_at.replace(' ', 'T') + 'Z').getTime() + 7 * 24 * 3600 * 1000);
    const note = document.createElement('div');
    note.className = 'hint';
    note.style.fontSize = '11.5px';
    note.textContent = 'Download until ' + until.toLocaleDateString('en-GB');
    tdFile.appendChild(note);

    const tdProg = document.createElement('td');
    tdProg.textContent = `${STATUS_TEXT[j.status] || j.status}: ${j.processed.toLocaleString()} of ${j.total.toLocaleString()}`;
    const bar = document.createElement('div'); bar.className = 'bar';
    const fill = document.createElement('i'); fill.style.width = pct + '%'; bar.appendChild(fill);
    tdProg.appendChild(bar);

    const tdRes = document.createElement('td');
    tdRes.textContent = Object.entries(j.counts || {})
      .map(([k, v]) => `${LABELS[k] || (k === 'error' ? 'Retry later' : k)} ${v.toLocaleString()}`).join(', ');

    const tdAct = document.createElement('td'); tdAct.className = 'act';
    const dl = document.createElement('a');
    dl.className = 'btn'; dl.href = `/api/jobs/${j.id}/download`; dl.textContent = 'Download';
    tdAct.appendChild(dl);
    if (j.status === 'queued' || j.status === 'running') {
      const cancel = document.createElement('button');
      cancel.className = 'small'; cancel.textContent = 'Cancel'; cancel.style.marginLeft = '6px';
      cancel.onclick = async () => {
        try { await api(`jobs/${j.id}/cancel`, {}); }
        catch (e) { say('uploadMsg', e.message, true); }
        await refreshJobs(); await refresh();
      };
      tdAct.appendChild(cancel);
    }
    tr.append(tdFile, tdProg, tdRes, tdAct);
    table.appendChild(tr);
  }
  box.appendChild(table);
}

async function refreshJobs() {
  clearTimeout(pollTimer);
  let active = true;
  try {
    const jobs = await api('jobs');
    renderJobs(jobs);
    active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
    await refreshCredits();
    await loadLedger();
  } catch (e) {
    if (e.message === 'Please log in.') return;
  }
  if (active) pollTimer = setTimeout(refreshJobs, 3000);
}
async function refreshCredits() {
  try {
    const credits = (await api('me')).credits.toLocaleString();
    $('credits').textContent = credits;
    $('accCredits').textContent = credits;
  } catch {}
}

$('upload').onclick = async () => {
  const file = $('csvFile').files[0];
  if (!file) return say('uploadMsg', 'Choose a CSV file first.', true);
  if (file.size > 9 * 1024 * 1024) return say('uploadMsg', 'File is too large (9 MB max).', true);
  say('uploadMsg', 'Uploading…');
  try {
    const csv = await file.text();
    const r = await api('jobs', { filename: file.name, csv });
    const notes = [];
    if (r.duplicatesRemoved) notes.push(`${r.duplicatesRemoved.toLocaleString()} duplicates removed`);
    if (r.badFormat) notes.push(`${r.badFormat.toLocaleString()} wrong-format rows`);
    say('uploadMsg', `Started: ${r.total.toLocaleString()} addresses${notes.length ? ' (' + notes.join(', ') + ')' : ''}.`);
    $('csvFile').value = '';
    await refresh(); await refreshJobs();
  } catch (e) { say('uploadMsg', e.message, true); }
};

const money = (cents, cur) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: cur.toUpperCase() }).format(cents / 100);

async function loadPlans() {
  try {
    const { plans, testMode, custom } = await api('plans');
    $('testNote').classList.toggle('hidden', !testMode);
    $('customAmount').min = custom.minDollars;
    $('customAmount').max = custom.maxDollars;
    const box = $('plans');
    box.textContent = '';
    for (const p of plans) {
      const b = document.createElement('button');
      b.textContent = `${money(p.priceCents, 'usd')} → ${p.totalCredits.toLocaleString()} credits` +
        (p.bonusCredits ? ` (includes ${p.bonusCredits} bonus)` : '');
      b.onclick = () => buy({ planId: p.id }, b);
      box.appendChild(b);
    }
  } catch { /* ignore */ }
}

async function buy(payload, btn) {
  btn.disabled = true; 
  say('buyMsg', 'Processing…');
  try {
    const r = await api('purchase', payload);
    if (r.crypto) { say('buyMsg', ''); showPayment(r.crypto); btn.disabled = false; return; }
    if (r.redirectUrl) { location.href = r.redirectUrl; return; }
    say('buyMsg', `Added ${r.added.toLocaleString()} credits. You now have ${r.credits.toLocaleString()}.`);
    await refresh();
  } catch (e) { say('buyMsg', e.message, true); }
  btn.disabled = false;
}

$('customBuy').onclick = () =>
  buy({ planId: 'custom', amount: Number($('customAmount').value) }, $('customBuy'));

async function loadOrders() {
  const box = $('orders');
  try {
    const rows = await api('orders');
    box.textContent = '';
    if (!rows.length) { box.innerHTML = '<p class="empty">No orders yet.</p>'; return; }
    const table = document.createElement('table');
    table.innerHTML = '<tr><th>Date</th><th>Credits</th><th>Price</th><th>Status</th></tr>';
    for (const o of rows) {
      const tr = document.createElement('tr');
      const when = new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString();
      for (const v of [when, o.bonus_credits ? `${o.credits.toLocaleString()} (incl. ${o.bonus_credits} bonus)` : o.credits.toLocaleString(), money(o.price_cents, o.currency), o.status]) {
        const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    box.appendChild(table);
  } catch { /* keep whatever is shown */ }
}

let payTimer = null;
function showPayment(c) {
  clearInterval(payTimer);
  const box = $('payBox');
  box.classList.remove('hidden');
  box.innerHTML = `
    <h3>Pay with USDT (TRC-20)</h3>
    <img id="payQr" alt="Wallet address QR code" width="200" height="200">
    <p>Send <strong>exactly</strong> <code id="payAmount"></code> USDT to:</p>
    <p><code id="payAddress" style="word-break:break-all"></code></p>
    <div class="row">
      <button id="copyAmount" class="small">Copy amount</button>
      <button id="copyAddress" class="small">Copy address</button>
    </div>
    <p class="hint"><strong>Use only the TRON (TRC-20) network, with USDT.</strong> Other networks or coins are lost for good.
    The amount must match exactly to the last digit, so make sure the amount <em>received</em> is exact (pay any exchange or wallet fee on top).
    The QR code contains the address only, so type the amount yourself.</p>
    <p id="payStatus" class="hint"></p>`;
  $('payQr').src = c.qr;
  $('payAmount').textContent = c.amount;
  $('payAddress').textContent = c.address;
  $('copyAmount').onclick = () => navigator.clipboard.writeText(c.amount);
  $('copyAddress').onclick = () => navigator.clipboard.writeText(c.address);

  const tick = async () => {
    try {
      const o = await api('orders/' + c.id);
      if (o.status === 'paid') {
        clearInterval(payTimer);
        $('payStatus').textContent = `Payment received. ${o.credits.toLocaleString()} credits added.`;
        await refresh();
        return;
      }
      if (o.status !== 'pending') {
        clearInterval(payTimer);
        $('payStatus').textContent = 'This payment request expired. Start a new one.';
        return;
      }
      const left = o.expiresAt - Date.now();
      $('payStatus').textContent = left > 0
        ? `Waiting for payment… ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')} left`
        : 'Time is up. If you already sent the payment in time, it will be credited shortly.';
    } catch { /* keep trying */ }
  };
  tick();
  payTimer = setInterval(tick, 5000);
}

async function loadLedger() {
  const box = $('ledger');
  try {
    const rows = await api('ledger');
    box.textContent = '';
    if (!rows.length) { box.innerHTML = '<p class="empty">No activity yet.</p>'; return; }
    const table = document.createElement('table');
    table.innerHTML = '<tr><th>Date</th><th>Activity</th><th>Details</th><th>Credits</th></tr>';
    for (const r of rows) {
      const tr = document.createElement('tr');
      const when = new Date(r.created_at.replace(' ', 'T') + 'Z').toLocaleString();
      const amount = (r.delta > 0 ? '+' : '') + r.delta.toLocaleString();
      for (const v of [when, REASONS[r.reason] || r.reason, r.detail || '', amount]) {
        const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    box.appendChild(table);
  } catch { /* keep whatever is shown */ }
}

const tabButtons = [...document.querySelectorAll('[data-tab]')];
const tabPanels = {
  plans: $('panel-plans'),
  single: $('panel-single'),
  batch: $('panel-batch'),
  profile: $('panel-profile')
};
tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const selected = button.dataset.tab;
    tabButtons.forEach((tab) => tab.setAttribute('aria-selected', String(tab === button)));
    Object.entries(tabPanels).forEach(([name, panel]) => { panel.hidden = name !== selected; });
  });
});

let toolsLoaded = false;
function loadTools() {
  if (toolsLoaded) return;
  toolsLoaded = true;
  const s = document.createElement('script');
  s.src = '/assets/panel.js';
  document.body.appendChild(s);
}
function clearTools() {
  toolsLoaded = false;
  const el = $('staff');
  el.textContent = '';
  el.classList.add('hidden');
}

loadPlans();
refresh().then(refreshJobs);