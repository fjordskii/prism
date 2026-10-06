// Server-rendered admin dashboard. Visual variant builder + templates — no raw JSON required.
export function dashboard(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Prism Admin</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 1080px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 32px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #777; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 12px; background: #eee; }
  .pill.on { background: #d3f9d8; } .pill.off { background: #ffe3e3; } .pill.sched { background: #dbe4ff; }
  button { font: inherit; padding: 6px 12px; border: 1px solid #ccc; background: #fff; border-radius: 6px; cursor: pointer; }
  button:hover { background: #f5f5f5; }
  input, select, textarea { font: inherit; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
  .rate { font-variant-numeric: tabular-nums; font-weight: 600; }
  .ci { font-size: 11px; color: #888; font-weight: 400; }
  .bar { height: 6px; background: #4c6ef5; border-radius: 3px; }
  .bar.ctrl { background: #adb5bd; }
  #builder { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; }
  #builder .full { grid-column: 1 / -1; }
  #builder label { font-size: 12px; color: #666; display: block; margin-bottom: 3px; }
  #builder input, #builder select, #builder textarea { width: 100%; }
  .tmpl { cursor: pointer; border: 1px solid #e5e5e5; border-radius: 8px; padding: 10px 14px; display: inline-block; margin: 4px 6px 0 0; font-size: 13px; }
  .tmpl:hover { border-color: #4c6ef5; background: #f4f7ff; }
  #lift { margin-top: 12px; padding: 12px 16px; background: #f4f7ff; border-radius: 8px; display: none; }
</style></head><body>
<h1>Prism — personalization admin</h1>
<p>Site: <code id="site">demo</code> · <a href="/" target="_blank">open demo storefront ↗</a> · <a href="/api/export?site=demo" id="export">export data (JSON)</a></p>

<h2>Performance <span style="font-weight:400;color:#777;font-size:13px" id="holdout"></span></h2>
<div id="lift"></div>
<table id="vt"><thead><tr>
  <th>Name</th><th>Selector</th><th>Audience</th><th>Impressions</th><th>Conversions</th><th>Rate (95% CI)</th><th>Status</th><th></th>
</tr></thead><tbody></tbody></table>

<h2>New variant — pick a template or start blank</h2>
<div id="templates"></div>
<div id="builder">
  <div><label>Name</label><input id="b-name" placeholder="Gift-buyer hero"></div>
  <div><label>CSS selector</label><input id="b-selector" placeholder="#hero"></div>
  <div><label>Audience rule — field</label><input id="b-field" placeholder="intent (blank = everyone)"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div><label>op</label><select id="b-op"><option>eq</option><option>neq</option><option>gt</option><option>lt</option><option>gte</option><option>lte</option><option>contains</option></select></div>
    <div><label>value</label><input id="b-value" placeholder="gift"></div>
  </div>
  <div class="full"><label>Content (HTML to swap in)</label><textarea id="b-html" rows="3" placeholder="<h1>The gift that fills a room.</h1>"></textarea></div>
  <div><label>Starts (optional)</label><input id="b-starts" type="datetime-local"></div>
  <div><label>Ends (optional — promo auto-expires)</label><input id="b-ends" type="datetime-local"></div>
  <div class="full"><button id="b-create">Create variant</button> <span id="b-msg" style="color:#2a9d6e"></span></div>
</div>

<script>
let site = new URLSearchParams(location.search).get('site') || 'demo';
const qs = new URLSearchParams(location.search);
const token = qs.get('token');
async function loadSites() {
  const sites = await fetch('/api/sites').then(r => r.json());
  const picker = document.getElementById('sitePicker');
  picker.innerHTML = '';
  if (!sites.includes(site)) sites.push(site);
  for (const s of sites.sort()) {
    const o = document.createElement('option');
    o.value = s; o.textContent = s; if (s === site) o.selected = true;
    picker.appendChild(o);
  }
}
document.getElementById('sitePicker').addEventListener('change', e => {
  const p = new URLSearchParams(location.search);
  p.set('site', e.target.value);
  location.search = p.toString();
});
document.getElementById('addSite').addEventListener('click', () => {
  const v = document.getElementById('newSite').value.trim();
  if (!v) return;
  const p = new URLSearchParams(location.search);
  p.set('site', v);
  location.search = p.toString();
});
function exportHref() { return '/api/export?site=' + site + (token ? '&token=' + token : ''); }
document.getElementById('export').href = exportHref();
document.getElementById('site').textContent = site;

const TEMPLATES = [
  { name: 'Gift-buyer hero', selector: '#hero', field: 'intent', op: 'eq', value: 'gift',
    html: '<small>GIFT-WRAPPED, FREE</small><h1>The gift that fills a room.</h1><p>Ready to give, in a linen box.</p><a class="btn" data-prism-convert="#hero" href="#shop">Shop gift sets</a>' },
  { name: 'Returning-customer subscribe strip', selector: '#pdp-strip', field: 'orders', op: 'gte', value: '1',
    html: '<div data-prism-convert="#pdp-strip" style="border:1px solid #ccc;padding:16px;border-radius:6px"><strong>Welcome back.</strong> Subscribe & save 15%. <button>Start subscription</button></div>' },
  { name: 'Bundle upsell', selector: '#grid', field: 'cartItems', op: 'gte', value: '3',
    html: '<p data-prism-convert="#grid" style="background:#111;color:#fff;padding:12px;text-align:center;border-radius:6px">Bundle & save — any three for $108.</p>' },
  { name: 'First-visit offer', selector: '#hero', field: 'visits', op: 'lte', value: '1',
    html: '<small>WELCOME</small><h1>First time here? Take 10% off.</h1><p>Code WELCOME10 at checkout.</p><a class="btn" data-prism-convert="#hero" href="#shop">Shop now</a>' },
  { name: 'Category affinity re-sort', selector: '#grid', field: 'affinity', op: 'eq', value: 'woody',
    html: '', note: 'uses a reorder op — edit after creating' },
];
const tDiv = document.getElementById('templates');
TEMPLATES.forEach(t => {
  const el = document.createElement('span');
  el.className = 'tmpl'; el.textContent = t.name;
  el.onclick = () => {
    document.getElementById('b-name').value = t.name;
    document.getElementById('b-selector').value = t.selector;
    document.getElementById('b-field').value = t.field;
    document.getElementById('b-op').value = t.op;
    document.getElementById('b-value').value = t.value;
    document.getElementById('b-html').value = t.html;
  };
  tDiv.appendChild(el);
});

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtCI(ci) { return ci ? (100*ci[0]).toFixed(1) + '–' + (100*ci[1]).toFixed(1) + '%' : ''; }
const OPSYM = { eq: '=', neq: '≠', gt: '>', lt: '<', gte: '≥', lte: '≤', contains: 'contains' };
function humanize(audience) {
  try {
    const rules = JSON.parse(audience);
    if (!rules.length) return 'everyone';
    return rules.map(r => r.field + ' ' + (OPSYM[r.op] || r.op) + ' ' + JSON.stringify(r.value)).join(' AND ');
  } catch { return audience; }
}
function editVariant(v) {
  document.getElementById('b-name').value = v.name;
  document.getElementById('b-selector').value = v.selector;
  let rules = [];
  try { rules = JSON.parse(v.audience); } catch {}
  const r0 = rules[0] || {};
  document.getElementById('b-field').value = r0.field || '';
  document.getElementById('b-op').value = r0.op || 'eq';
  document.getElementById('b-value').value = r0.value != null ? String(r0.value) : '';
  let html = '';
  try { const ops = JSON.parse(v.ops); html = (ops.find(o => o.op === 'html') || {}).html || ''; } catch {}
  document.getElementById('b-html').value = html;
  document.getElementById('b-starts').value = v.starts_at ? new Date(v.starts_at).toISOString().slice(0,16) : '';
  document.getElementById('b-ends').value = v.ends_at ? new Date(v.ends_at).toISOString().slice(0,16) : '';
  document.getElementById('b-msg').textContent = 'Editing “' + v.name + '” — Create saves as a new variant; pause the old one.';
  document.getElementById('builder').scrollIntoView({ behavior: 'smooth' });
}

async function load() {
  const [variants, stats] = await Promise.all([
    fetch('/api/variants?site=' + site).then(r => r.json()),
    fetch('/api/stats?site=' + site).then(r => r.json()),
  ]);
  const byId = Object.fromEntries(stats.variants.map(s => [s.id, s]));
  document.getElementById('holdout').textContent = '· ' + stats.holdoutPct + '% holdout control';
  const c = stats.control;
  const liftDiv = document.getElementById('lift');
  if (c.impressions > 0) {
    const treated = stats.variants.reduce((a, s) => ({ i: a.i + s.impressions, c: a.c + s.conversions }), { i: 0, c: 0 });
    const tr = treated.i ? treated.c / treated.i : 0, cr = c.conversions / c.impressions;
    liftDiv.style.display = 'block';
    liftDiv.innerHTML = '<b>Incremental lift vs holdout:</b> personalized ' + (100*tr).toFixed(1) + '% (' + treated.i + ' impressions) vs control ' + (100*cr).toFixed(1) + '% (' + c.impressions + ') → <b>' + (cr ? ((tr/cr - 1) * 100).toFixed(0) : '∞') + '% relative lift</b>';
  }
  const tb = document.querySelector('#vt tbody');
  tb.innerHTML = '';
  const maxImp = Math.max(1, ...stats.variants.map(s => s.impressions));
  for (const v of variants) {
    const s = byId[v.id] || { impressions: 0, conversions: 0, rate: null, ci95: null };
    const now = Date.now();
    let status = v.active ? '<span class="pill on">active</span>' : '<span class="pill off">paused</span>';
    if (v.ends_at && v.ends_at <= now) status = '<span class="pill off">expired</span>';
    else if (v.starts_at && v.starts_at > now) status = '<span class="pill sched">scheduled</span>';
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><b>' + esc(v.name) + '</b></td>' +
      '<td><code>' + esc(v.selector) + '</code></td>' +
      '<td style="font-size:12px">' + esc(humanize(v.audience)) + '</td>' +
      '<td>' + s.impressions + '<div class="bar" style="width:' + (100 * s.impressions / maxImp) + '%"></div></td>' +
      '<td>' + s.conversions + '</td>' +
      '<td class="rate">' + (s.rate != null ? (100*s.rate).toFixed(1) + '%' : '—') + ' <span class="ci">' + fmtCI(s.ci95) + '</span></td>' +
      '<td>' + status + '</td>' +
      '<td><button data-edit="' + v.id + '">Edit</button> ' +
      '<button onclick="toggle(' + v.id + ')">' + (v.active ? 'Pause' : 'Resume') + '</button> ' +
      '<button onclick="del(' + v.id + ')">Delete</button></td>';
    tb.appendChild(tr);
    tr.querySelector('[data-edit]').addEventListener('click', () => editVariant(v));
  }
  // control row
  if (c.impressions > 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td style="color:#777"><i>Control (holdout)</i></td><td>—</td><td>—</td>' +
      '<td>' + c.impressions + '<div class="bar ctrl" style="width:' + (100 * c.impressions / maxImp) + '%"></div></td>' +
      '<td>' + c.conversions + '</td>' +
      '<td class="rate">' + (c.rate != null ? (100*c.rate).toFixed(1) + '%' : '—') + ' <span class="ci">' + fmtCI(c.ci95) + '</span></td>' +
      '<td colspan="2"></td>';
    tb.appendChild(tr);
  }
}
async function toggle(id) { await authFetch('/api/variants/' + id + '/toggle', { method: 'POST' }); load(); }
async function del(id) { if (confirm('Delete variant?')) { await authFetch('/api/variants/' + id, { method: 'DELETE' }); load(); } }
function authFetch(url, opts) {
  opts = opts || {};
  return fetch(url, opts);
}
document.getElementById('b-create').addEventListener('click', async () => {
  const field = document.getElementById('b-field').value.trim();
  let val = document.getElementById('b-value').value.trim();
  if (val !== '' && !isNaN(+val)) val = +val;
  const audience = field ? [{ field, op: document.getElementById('b-op').value, value: val }] : [];
  const html = document.getElementById('b-html').value;
  const starts = document.getElementById('b-starts').value, ends = document.getElementById('b-ends').value;
  const body = {
    site, name: document.getElementById('b-name').value,
    selector: document.getElementById('b-selector').value,
    audience: JSON.stringify(audience),
    ops: JSON.stringify(html ? [{ op: 'html', html }] : []),
    starts_at: starts ? new Date(starts).getTime() : null,
    ends_at: ends ? new Date(ends).getTime() : null,
  };
  const r = await authFetch('/api/variants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  document.getElementById('b-msg').textContent = r.ok ? 'Created ✓' : 'Error: ' + (await r.text());
  if (r.ok) setTimeout(() => document.getElementById('b-msg').textContent = '', 2000);
  load();
});
loadSites(); load(); setInterval(load, 5000);
</script>
</body></html>`;
}
