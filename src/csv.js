export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t']
    .map((d) => [d, first.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const clean = (v) => String(v ?? '').trim().replace(/^["'<]+|["'>]+$/g, '').toLowerCase();

export function extractEmails(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!rows.length) return { valid: [], bad: [], duplicates: 0 };

  const col = rows[0].findIndex((h) => /e-?mail/i.test(h));
  const candidates = col >= 0 ? rows.slice(1).map((r) => r[col]) : rows.flat();

  const seen = new Set(), valid = [], bad = [];
  let duplicates = 0;
  for (const raw of candidates) {
    const e = clean(raw);
    if (!e) continue;
    const ok = EMAIL_RE.test(e) && e.length <= 254;
    if (!ok && col < 0) continue;
    if (seen.has(e)) { duplicates++; continue; }
    seen.add(e);
    (ok ? valid : bad).push(e);
  }
  return { valid, bad, duplicates };
}

export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}