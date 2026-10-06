// Server-rendered admin dashboard. Boring HTML + inline fetch — no build step.
export function dashboard(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Prism Admin</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 32px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e5e5; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #777; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 12px; background: #eee; }
  .pill.on { background: #d3f9d8; } .pill.off { background: #ffe3e3; }
  button { font: inherit; padding: 6px 12px; border: 1px solid #ccc; background: #fff; border-radius: 6px; cursor: pointer; }
  button:hover { background: #f5f5f5; }
  input, select, textarea { font: inherit; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; width: 100%; box-sizing: border-box; }
  form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
  form .full { grid-column: 1 / -1; }
  .rate { font-variant-numeric: tabular-nums; font-weight: 600; }
  .bar { height: 6px; background: #4c6ef5; border-radius: 3px; }
</style></head><body>
<h1>Prism — personalization admin</h1>
<p>Site: <code id="site">demo</code> · <a href="/" target="_blank">open demo storefront ↗</a></p>

<h2>Variants</h2>
<table id="vt"><thead><tr>
  <th>Name</th><th>Selector</th><th>Audience</th><th>Impressions</th><th>Conversions</th><th>Rate</th><th>Status</th><th></th>
</tr></thead><tbody></tbody></table>

<h2>New variant</h2>
<form id="nf">
  <input name="name" placeholder="Name (e.g. Gift-buyer hero)" required>
  <input name="selector" placeholder="CSS selector (e.g. #hero)" required>
  <textarea name="audience" class="full" placeholder='Audience rules JSON, e.g. [{"field":"affinity","op":"eq","value":"woody"}]'></textarea>
  <textarea name="ops" class="full" placeholder='Ops JSON, e.g. [{"op":"html","html":"<h1>Gifts!</h1>"}]' required></textarea>
  <button type="submit">Create variant</button>
</form>

<script>
const site = 'demo';
async function load() {
  const [variants, stats] = await Promise.all([
    fetch('/api/variants?site=' + site).then(r => r.json()),
    fetch('/api/stats?site=' + site).then(r => r.json()),
  ]);
  const statsById = Object.fromEntries(stats.map(s => [s.id, s]));
  const tb = document.querySelector('#vt tbody');
  tb.innerHTML = '';
  const maxImp = Math.max(1, ...stats.map(s => s.impressions || 0));
  for (const v of variants) {
    const s = statsById[v.id] || {};
    const imp = s.impressions || 0, conv = s.conversions || 0;
    const rate = imp ? (100 * conv / imp).toFixed(1) + '%' : '—';
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><b>' + esc(v.name) + '</b></td>' +
      '<td><code>' + esc(v.selector) + '</code></td>' +
      '<td><code>' + esc(v.audience) + '</code></td>' +
      '<td>' + imp + '<div class="bar" style="width:' + (100 * imp / maxImp) + '%"></div></td>' +
      '<td>' + conv + '</td>' +
      '<td class="rate">' + rate + '</td>' +
      '<td><span class="pill ' + (v.active ? 'on' : 'off') + '">' + (v.active ? 'active' : 'paused') + '</span></td>' +
      '<td><button onclick="toggle(' + v.id + ')">' + (v.active ? 'Pause' : 'Resume') + '</button> ' +
      '<button onclick="del(' + v.id + ')">Delete</button></td>';
    tb.appendChild(tr);
  }
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function toggle(id) { await fetch('/api/variants/' + id + '/toggle', { method: 'POST' }); load(); }
async function del(id) { if (confirm('Delete variant?')) { await fetch('/api/variants/' + id, { method: 'DELETE' }); load(); } }
document.querySelector('#nf').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    site, name: f.get('name'), selector: f.get('selector'),
    audience: f.get('audience') || '[]',
    ops: f.get('ops'),
  };
  try { JSON.parse(body.audience); JSON.parse(body.ops); } catch { alert('Audience and Ops must be valid JSON'); return; }
  const r = await fetch('/api/variants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) alert(await r.text());
  e.target.reset(); load();
});
load(); setInterval(load, 5000);
</script>
</body></html>`;
}
