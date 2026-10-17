// Served only to accounts with is_admin = 1 (see /assets/panel.js in server.js).
// Uses $, say and refresh from the main page script.
// Every request here also needs the ADMIN_KEY, which is kept in memory only.
(() => {
  const box = $('staff');
  if (!box) return;
  let key = '';

  async function ops(path, body) {
    const res = await fetch('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  box.innerHTML = `
    <h2>Tools</h2>
    <div id="kLock">
      <p class="section-intro">Enter your key to unlock.</p>
      <label for="kKey">Key</label>
      <input id="kKey" type="password" autocomplete="off" placeholder="Enter key">
      <div class="actions"><button id="kGo">Unlock</button></div>
      <div id="kMsg" class="msg" role="status"></div>
    </div>

    <div id="kBody" class="hidden">
      <h3>Create customer account</h3>
      <div class="row">
        <input id="uUser" type="text" autocomplete="off" placeholder="username" aria-label="New username">
        <input id="uPass" type="text" autocomplete="off" placeholder="password (8+ characters)" aria-label="New password">
      </div>
      <div class="actions"><button id="uGo">Create account</button></div>
      <div id="uMsg" class="msg" role="status"></div>

      <h3 style="margin-top:24px">Customer credits</h3>
      <div class="row">
        <input id="gUser" type="text" placeholder="customer username" aria-label="Customer username">
        <input id="gAmount" type="number" placeholder="Credits" aria-label="Number of credits" style="max-width:120px">
      </div>
      <div class="actions"><button id="gGo">Add credits</button></div>
      <div id="gMsg" class="msg" role="status"></div>

      <h3 style="margin-top:24px">Unpaid crypto orders</h3>
      <p class="section-intro">Check the transfer on tronscan.org before approving: your wallet as recipient, USDT (TRC-20), confirmed, right amount.</p>
      <div class="actions"><button id="oReload" class="small">Refresh list</button></div>
      <div id="oList"></div>
      <div id="oMsg" class="msg" role="status"></div>

      <div class="actions" style="margin-top:24px"><button id="kLockBtn" class="ghost small">Lock</button></div>
    </div>`;
  box.classList.remove('hidden');

  // ---------- lock / unlock ----------

  async function unlock() {
    key = $('kKey').value;
    say('kMsg', 'Checking…');
    try {
      const rows = await ops('ops/orders');
      $('kKey').value = '';
      say('kMsg', '');
      $('kLock').classList.add('hidden');
      $('kBody').classList.remove('hidden');
      renderOrders(rows);
    } catch (e) {
      key = '';
      say('kMsg', e.message, true);
    }
  }

  function lock() {
    key = '';
    $('kBody').classList.add('hidden');
    $('kLock').classList.remove('hidden');
    $('oList').textContent = '';
    for (const id of ['uMsg', 'gMsg', 'oMsg']) say(id, '');
  }

  $('kGo').onclick = unlock;
  $('kKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  $('kLockBtn').onclick = lock;

  // ---------- create account ----------

  $('uGo').onclick = async () => {
    const username = $('uUser').value.trim().toLowerCase();
    try {
      await ops('ops/create-user', { username, password: $('uPass').value });
      say('uMsg', `Created "${username}".`);
      $('uUser').value = ''; $('uPass').value = '';
    } catch (e) { say('uMsg', e.message, true); }
  };

  // ---------- add credits ----------

  $('gGo').onclick = async () => {
    try {
      const r = await ops('ops/grant', { username: $('gUser').value, amount: $('gAmount').value });
      say('gMsg', `Done. That customer now has ${r.credits.toLocaleString()} credits.`);
      await refresh();
    } catch (e) { say('gMsg', e.message, true); }
  };

  // ---------- unpaid orders ----------

  function renderOrders(rows) {
    const list = $('oList');
    list.textContent = '';
    if (!rows.length) { list.innerHTML = '<p class="empty">No unpaid crypto orders.</p>'; return; }
    const table = document.createElement('table');
    table.innerHTML = '<tr><th>Order</th><th>User</th><th>USDT</th><th>Credits</th><th>Status</th><th>Created</th><th>Approve</th></tr>';
    for (const o of rows) {
      const tr = document.createElement('tr');
      const when = new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString();
      for (const v of ['#' + o.id, o.username, o.amount, o.credits.toLocaleString(), o.status, when]) {
        const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      }
      const td = document.createElement('td');
      const hash = document.createElement('input');
      hash.placeholder = 'tx hash (optional)'; hash.style.maxWidth = '190px';
      const cr = document.createElement('input');
      cr.type = 'number'; cr.placeholder = 'credits'; cr.style.maxWidth = '90px';
      const btn = document.createElement('button');
      btn.className = 'small'; btn.textContent = 'Approve';
      btn.onclick = async () => {
        const credits = cr.value === '' ? o.credits : Number(cr.value);
        if (!confirm(`Give ${credits.toLocaleString()} credits to ${o.username} for order #${o.id}?`)) return;
        btn.disabled = true;
        try {
          await ops(`ops/orders/${o.id}/approve`, { txId: hash.value, credits: cr.value });
          say('oMsg', `Order #${o.id} approved.`);
        } catch (e) { say('oMsg', e.message, true); }
        await loadOrders();
      };
      const del = document.createElement('button');
      del.className = 'small danger'; del.textContent = 'Delete'; del.style.marginLeft = '6px';
      del.onclick = async () => {
        if (!confirm(`Delete order #${o.id} (${o.username}, ${o.amount} USDT)? If this customer already sent the payment, it will no longer be matched automatically.`)) return;
        del.disabled = true;
        try {
          await ops(`ops/orders/${o.id}/delete`, {});
          say('oMsg', `Order #${o.id} deleted.`);
        } catch (e) { say('oMsg', e.message, true); }
        await loadOrders();
      };
      td.append(hash, cr, btn, del);
      tr.appendChild(td);
      table.appendChild(tr);
    }
    list.appendChild(table);
  }

  async function loadOrders() {
    try { renderOrders(await ops('ops/orders')); }
    catch (e) { say('oMsg', e.message, true); }
  }

  $('oReload').onclick = loadOrders;
})();