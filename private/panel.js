// Served only to accounts with is_admin = 1
// Uses $, api, say and refresh from the main page script.
(() => {
  const box = $('staff');
  if (!box) return;

  box.innerHTML = `
    <h2>Customer credits</h2>
    <div class="row">
      <input id="gUser" type="text" placeholder="customer username" aria-label="Customer username">
      <input id="gAmount" type="number" placeholder="Credits" aria-label="Number of credits" style="max-width:120px">
    </div>
    <div class="actions"><button id="gGo">Add credits</button></div>
    <div id="gMsg" class="msg" role="status"></div>

    <h2 style="margin-top:24px">Unpaid crypto orders</h2>
    <p class="section-intro">Check the transfer on tronscan.org before approving: your wallet as recipient, USDT (TRC-20), confirmed, right amount.</p>
    <div class="actions"><button id="oReload" class="small">Refresh list</button></div>
    <div id="oList"></div>
    <div id="oMsg" class="msg" role="status"></div>`;
  box.classList.remove('hidden');

  $('gGo').onclick = async () => {
    try {
      const r = await api('ops/grant', { username: $('gUser').value, amount: $('gAmount').value });
      say('gMsg', `Done. That customer now has ${r.credits.toLocaleString()} credits.`);
      await refresh();
    } catch (e) { say('gMsg', e.message, true); }
  };

  async function loadOrders() {
    const list = $('oList');
    try {
      const rows = await api('ops/orders');
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
            await api(`ops/orders/${o.id}/approve`, { txId: hash.value, credits: cr.value });
            say('oMsg', `Order #${o.id} approved.`);
          } catch (e) { say('oMsg', e.message, true); }
          await loadOrders();
        };
        td.append(hash, cr, btn);
        tr.appendChild(td);
        table.appendChild(tr);
      }
      list.appendChild(table);
    } catch (e) { say('oMsg', e.message, true); }
  }

  $('oReload').onclick = loadOrders;
  loadOrders();
})();