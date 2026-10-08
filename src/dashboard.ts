// Server-rendered admin dashboard. Visual variant builder + templates — no raw JSON required.
export function dashboard(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Prism Admin</title>
<style>
  :root {
    --ink: #14161c; --muted: #6b7280; --faint: #9aa1ad;
    --line: #e6e8ee; --line-soft: #eef0f4;
    --bg: #f6f7f9; --card: #ffffff;
    --accent: #4c6ef5; --accent-ink: #3b5bdb; --accent-soft: #eef2ff;
    --green: #2b8a3e; --green-soft: #e6f4ea;
    --red: #d64545; --red-soft: #fdecec;
    --radius: 12px;
    --shadow: 0 1px 2px rgba(16,20,30,.05), 0 4px 16px rgba(16,20,30,.05);
  }
  * { box-sizing: border-box; }
  body { font: 13.5px/1.55 -apple-system, "SF Pro Text", system-ui, "Segoe UI", sans-serif; margin: 0; background: var(--bg); color: var(--ink); -webkit-font-smoothing: antialiased; }

  .topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 12px 28px; background: rgba(255,255,255,.88); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
  .brand { font-size: 15px; font-weight: 700; letter-spacing: -.01em; display: flex; align-items: center; gap: 9px; }
  .brand .mark { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, #4c6ef5, #9775fa); }
  .brand .sub { font-weight: 500; color: var(--muted); }
  .sitebar { display: flex; align-items: center; gap: 8px; }
  .sitebar label { font-size: 11px; font-weight: 650; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .topnav a { color: var(--muted); text-decoration: none; font-size: 13px; margin-left: 18px; }
  .topnav a:hover { color: var(--ink); }

  .wrap { max-width: 1120px; margin: 0 auto; padding: 24px 28px 64px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 20px; }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 16px 20px 12px; border-bottom: 1px solid var(--line-soft); }
  .card-head h2 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: -.005em; }
  .card-head .meta { font-size: 12px; color: var(--muted); }

  table { border-collapse: collapse; width: 100%; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); font-weight: 600; text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  td { text-align: left; padding: 12px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: #fafbfd; }
  tr.control-row td { background: #fafbfc; color: var(--muted); }
  tr.control-row td:first-child { font-style: italic; }
  td code { background: var(--line-soft); padding: 2px 6px; border-radius: 5px; font-size: 12px; }
  .tablewrap { overflow-x: auto; padding-bottom: 6px; }

  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 99px; background: currentColor; }
  .pill.on { background: var(--green-soft); color: var(--green); }
  .pill.off { background: var(--red-soft); color: var(--red); }
  .pill.sched { background: var(--accent-soft); color: var(--accent-ink); }

  button { font: inherit; font-weight: 550; padding: 6px 12px; border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 8px; cursor: pointer; transition: all .12s ease; }
  button:hover { border-color: #c9ced8; background: #f8f9fb; }
  button:active { transform: translateY(1px); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { background: var(--accent-ink); border-color: var(--accent-ink); }
  button.danger { color: var(--red); }
  button.danger:hover { background: var(--red-soft); border-color: #f0c1c1; }
  .row-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .row-actions button { padding: 4px 10px; font-size: 12px; }

  input, select, textarea { font: inherit; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); transition: border-color .12s, box-shadow .12s; }
  select { appearance: none; -webkit-appearance: none; padding-right: 30px; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%236b7280' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>"); background-repeat: no-repeat; background-position: right 11px center; }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(76,110,245,.15); outline: none; }
  input::placeholder, textarea::placeholder { color: var(--faint); }
  button:focus-visible, a:focus-visible, .tmpl:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .rate { font-variant-numeric: tabular-nums; font-weight: 650; font-size: 14px; white-space: nowrap; }
  .ci { display: block; font-size: 11px; color: var(--faint); font-weight: 400; }
  .bar { height: 5px; background: linear-gradient(90deg, #4c6ef5, #9775fa); border-radius: 3px; margin-top: 5px; min-width: 2px; }
  .bar.ctrl { background: #cfd4dc; }

  #lift { display: none; align-items: center; gap: 18px; margin: 14px 20px 4px; padding: 14px 18px; background: linear-gradient(135deg, #eef2ff, #f5f0ff); border: 1px solid #dfe6fd; border-radius: 10px; }
  .lift-num { font-size: 30px; font-weight: 750; letter-spacing: -.02em; color: var(--accent-ink); font-variant-numeric: tabular-nums; }
  .lift-body { font-size: 13px; color: #3f4b63; }

  #segments { padding: 10px 20px 16px; }
  .segrow { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 7px 0; border-bottom: 1px dashed var(--line-soft); }
  .segrow:last-child { border-bottom: none; }
  .segfield { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; font-size: 12px; min-width: 110px; }
  .segchip { background: var(--line-soft); border-radius: 6px; padding: 2px 8px; font-size: 12px; color: #374151; }
  .segchip b { color: var(--faint); font-weight: 500; margin-left: 4px; }

  #templates { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 20px 0; }
  .tmpl { cursor: pointer; border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 550; color: #374151; background: #fff; transition: all .12s ease; }
  .tmpl:hover { border-color: var(--accent); color: var(--accent-ink); background: var(--accent-soft); }
  .tmpl:active { transform: translateY(1px); }

  #builder { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; padding: 16px 20px 20px; }
  #builder .full { grid-column: 1 / -1; }
  #builder label { font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); display: block; margin-bottom: 5px; }
  #builder input, #builder select, #builder textarea { width: 100%; }
  #b-msg { font-size: 12.5px; color: var(--green); margin-left: 10px; }

  /* visual block editor */
  #modebar { display: inline-flex; gap: 0; margin: 6px 0 10px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .modebtn { border: none; border-radius: 0; padding: 5px 14px; font-size: 12px; background: #fff; color: var(--muted); }
  .modebtn.on { background: var(--accent-soft); color: var(--accent-ink); font-weight: 650; }
  .modebtn:hover { background: var(--accent-soft); }
  #palette { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .pal { cursor: pointer; border: 1px dashed #c9ced8; border-radius: 8px; padding: 6px 12px; font-size: 12.5px; font-weight: 550; color: var(--muted); background: #fff; transition: all .12s ease; }
  .pal:hover { border-color: var(--accent); color: var(--accent-ink); background: var(--accent-soft); }
  #canvas { display: flex; flex-direction: column; gap: 8px; min-height: 44px; padding: 8px; border: 1px solid var(--line-soft); border-radius: 10px; background: #fafbfd; }
  #canvas:empty::before { content: "Add blocks from the palette above — no HTML needed"; color: var(--faint); font-size: 12.5px; padding: 8px; }
  .blk { display: flex; gap: 8px; align-items: flex-start; background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
  .blk.dragging { opacity: .45; }
  .blk.drop-above { box-shadow: 0 -2px 0 var(--accent); }
  .blk.drop-below { box-shadow: 0 2px 0 var(--accent); }
  .blk .grip { cursor: grab; color: var(--faint); font-size: 14px; line-height: 1; padding: 6px 2px; user-select: none; touch-action: none; }
  .blk .grip:active { cursor: grabbing; }
  .blk .blk-body { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .blk .blk-tag { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
  .blk input, .blk textarea { width: 100%; padding: 6px 9px; font-size: 13px; }
  .blk textarea { resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .blk .blk-ops { display: flex; flex-direction: column; gap: 2px; }
  .blk .blk-ops button { padding: 2px 7px; font-size: 12px; border: none; background: none; color: var(--faint); }
  .blk .blk-ops button:hover { color: var(--ink); background: var(--line-soft); }
  .blk .blk-ops button.del:hover { color: var(--red); background: var(--red-soft); }
  #previewwrap { margin-top: 12px; }
  #previewwrap label { font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); display: block; margin-bottom: 5px; }
  #preview { border: 1px solid var(--line-soft); border-radius: 10px; padding: 18px 20px; background: #fff; min-height: 40px; overflow: hidden; }
  #preview:empty::before { content: "Preview appears here"; color: var(--faint); font-size: 12.5px; }
  #preview img { max-width: 100%; }
  #preview .btn, #preview a.btn { display: inline-block; background: var(--ink); color: #fff; padding: 10px 22px; border-radius: 4px; text-decoration: none; font-size: 13px; letter-spacing: .04em; }

  @media (max-width: 720px) {
    #builder { grid-template-columns: 1fr; }
    .topbar { flex-direction: column; align-items: flex-start; gap: 10px; }
    .topnav a { margin-left: 0; margin-right: 16px; }
    .wrap { padding: 16px 14px 48px; }
  }
</style></head><body>
<header class="topbar">
  <div class="brand"><span class="mark"></span>Prism <span class="sub">personalization admin</span></div>
  <div class="sitebar">
    <label for="sitePicker">Site</label>
    <select id="sitePicker"></select>
    <input id="newSite" placeholder="new site slug" style="width:130px">
    <button id="addSite">Add</button>
  </div>
  <nav class="topnav">
    <a href="/demo/" target="_blank">Demo storefront ↗</a>
    <a id="archlink" href="/architecture">Architecture</a>
    <a id="export" href="#">Export JSON</a>
  </nav>
</header>

<main class="wrap">

<section class="card">
  <div class="card-head">
    <h2>Performance</h2>
    <div class="meta"><span id="holdout"></span> <span id="planuse"></span> <span id="overlimit" style="color:var(--red);font-weight:600"></span></div>
  </div>
  <div id="lift"></div>
  <div class="tablewrap">
  <table id="vt"><thead><tr>
    <th>Name</th><th>Selector</th><th>Audience</th><th>Impressions</th><th>Conv.</th><th>Rate (95% CI)</th><th>Status</th><th style="text-align:right">Actions</th>
  </tr></thead><tbody></tbody></table>
  </div>
</section>

<section class="card">
  <div class="card-head"><h2>Segments</h2><div class="meta">visitor traits reported by the snippet</div></div>
  <div id="segments"></div>
</section>

<section class="card">
  <div class="card-head"><h2>New variant</h2><div class="meta">pick a template or start blank</div></div>
  <div id="templates"></div>
  <div id="builder">
  <div><label>Name</label><input id="b-name" placeholder="Gift-buyer hero"></div>
  <div><label>CSS selector</label><input id="b-selector" placeholder="#hero"></div>
  <div><label>Audience rule field</label><input id="b-field" placeholder="intent (blank = everyone)"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div><label>op</label><select id="b-op"><option>eq</option><option>neq</option><option>gt</option><option>lt</option><option>gte</option><option>lte</option><option>contains</option></select></div>
    <div><label>value</label><input id="b-value" placeholder="gift"></div>
  </div>
  <div class="full">
    <label>Content (what gets swapped in)</label>
    <div id="modebar">
      <button type="button" class="modebtn on" id="mode-visual">Visual blocks</button>
      <button type="button" class="modebtn" id="mode-html">HTML</button>
    </div>
    <div id="visualeditor">
      <div id="palette"></div>
      <div id="canvas"></div>
      <div id="previewwrap"><label>Preview</label><div id="preview"></div></div>
    </div>
    <textarea id="b-html" rows="3" placeholder="<h1>The gift that fills a room.</h1>" style="display:none"></textarea>
  </div>
  <div><label>Starts (optional)</label><input id="b-starts" type="datetime-local"></div>
  <div><label>Ends (optional, promos auto-expire)</label><input id="b-ends" type="datetime-local"></div>
  <div class="full"><button id="b-create" class="primary">Create variant</button><span id="b-msg"></span></div>
  </div>
</section>

</main>

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
document.getElementById('archlink').href = '/architecture' + (token ? '?token=' + encodeURIComponent(token) : '');

const TEMPLATES = [
  { name: 'Gift-buyer hero', selector: '#hero', field: 'intent', op: 'eq', value: 'gift',
    html: '<small>GIFT-WRAPPED, FREE</small><h1>The gift that fills a room.</h1><p>Ready to give, in a linen box.</p><a class="btn" data-prism-convert="#hero" href="#shop">Shop gift sets</a>' },
  { name: 'Returning-customer subscribe strip', selector: '#pdp-strip', field: 'orders', op: 'gte', value: '1',
    html: '<div data-prism-convert="#pdp-strip" style="border:1px solid #ccc;padding:16px;border-radius:6px"><strong>Welcome back.</strong> Subscribe & save 15%. <button>Start subscription</button></div>' },
  { name: 'Bundle upsell', selector: '#grid', field: 'cartItems', op: 'gte', value: '3',
    html: '<p data-prism-convert="#grid" style="background:#111;color:#fff;padding:12px;text-align:center;border-radius:6px">Bundle & save: any three for $108.</p>' },
  { name: 'First-visit offer', selector: '#hero', field: 'visits', op: 'lte', value: '1',
    html: '<small>WELCOME</small><h1>First time here? Take 10% off.</h1><p>Code WELCOME10 at checkout.</p><a class="btn" data-prism-convert="#hero" href="#shop">Shop now</a>' },
  { name: 'Category affinity re-sort', selector: '#grid', field: 'affinity', op: 'eq', value: 'woody',
    html: '', note: 'uses a reorder op; edit after creating' },
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
    syncFromHTML();
  };
  tDiv.appendChild(el);
});

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
// ---------- visual block editor: palette -> canvas (drag to reorder) -> b-html ----------
// b-html stays the single source of truth for create/edit; the canvas mirrors it.
const BLOCK_DEFS = {
  eyebrow: { label: 'Eyebrow', hint: 'small caps label', props: { text: 'NEW COLLECTION' } },
  heading: { label: 'Heading', hint: 'large title', props: { text: 'Your headline here.' } },
  text:    { label: 'Text', hint: 'paragraph', props: { text: 'A short supporting sentence.' } },
  button:  { label: 'Button', hint: 'call-to-action link', props: { text: 'Shop now', href: '#shop', convert: '' } },
  banner:  { label: 'Banner', hint: 'full-width promo strip', props: { text: 'Free shipping over $75.' } },
  image:   { label: 'Image', hint: 'picture by URL', props: { src: 'https://', alt: '' } },
};
function blocksToHTML(blocks) {
  return blocks.map(b => {
    const p = b.props;
    if (b.type === 'eyebrow') return '<small style="letter-spacing:.2em;text-transform:uppercase;color:#8a8175">' + esc(p.text) + '</small>';
    if (b.type === 'heading') return '<h1>' + esc(p.text) + '</h1>';
    if (b.type === 'text') return '<p>' + esc(p.text) + '</p>';
    if (b.type === 'button') return '<a class="btn"' + (p.convert ? ' data-prism-convert="' + esc(p.convert) + '"' : '') + ' href="' + esc(p.href) + '">' + esc(p.text) + '</a>';
    if (b.type === 'banner') return '<p style="background:#14161c;color:#fff;padding:12px 16px;text-align:center;border-radius:6px">' + esc(p.text) + '</p>';
    if (b.type === 'image') return '<img src="' + esc(p.src) + '" alt="' + esc(p.alt) + '" style="max-width:100%">';
    return '';
  }).join('\\n');
}
// Best-effort parse of authored HTML back into blocks; returns null when the markup
// is not block-shaped (caller keeps raw HTML mode instead of destroying content).
function htmlToBlocks(html) {
  const frag = document.createElement('div');
  frag.innerHTML = html.trim();
  if (!frag.children.length && !frag.textContent.trim()) return [];
  const blocks = [];
  for (const el of frag.children) {
    const t = el.tagName;
    if (t === 'SMALL') blocks.push({ type: 'eyebrow', props: { text: el.textContent } });
    else if (/^H[1-3]$/.test(t)) blocks.push({ type: 'heading', props: { text: el.textContent } });
    else if (t === 'A') blocks.push({ type: 'button', props: { text: el.textContent, href: el.getAttribute('href') || '', convert: el.getAttribute('data-prism-convert') || '' } });
    else if (t === 'IMG') blocks.push({ type: 'image', props: { src: el.getAttribute('src') || '', alt: el.getAttribute('alt') || '' } });
    else if (t === 'P' && !el.children.length) blocks.push({ type: el.style.background ? 'banner' : 'text', props: { text: el.textContent } });
    else return null;
  }
  return blocks;
}
let blocks = [];
const canvasEl = document.getElementById('canvas');
const paletteEl = document.getElementById('palette');
const htmlEl = document.getElementById('b-html');
const previewEl = document.getElementById('preview');
function syncFromBlocks() {
  htmlEl.value = blocksToHTML(blocks);
  previewEl.innerHTML = htmlEl.value;
}
function renderCanvas() {
  canvasEl.innerHTML = '';
  blocks.forEach((b, i) => {
    const def = BLOCK_DEFS[b.type];
    const row = document.createElement('div');
    row.className = 'blk'; row.draggable = true; row.dataset.idx = i;
    const grip = document.createElement('span');
    grip.className = 'grip'; grip.textContent = '\\u2807\\u2807'; grip.title = 'Drag to reorder';
    const body = document.createElement('div');
    body.className = 'blk-body';
    const tag = document.createElement('span');
    tag.className = 'blk-tag'; tag.textContent = def.label + ' — ' + def.hint;
    body.appendChild(tag);
    const PROP_LABELS = { text: 'Text', href: 'Link URL', convert: 'Conversion selector (optional, e.g. #hero)', src: 'Image URL', alt: 'Alt text' };
    for (const key of Object.keys(b.props)) {
      const inp = document.createElement('input');
      inp.placeholder = PROP_LABELS[key] || key; inp.value = b.props[key];
      inp.addEventListener('input', () => { b.props[key] = inp.value; syncFromBlocks(); });
      body.appendChild(inp);
    }
    const ops = document.createElement('div');
    ops.className = 'blk-ops';
    const up = document.createElement('button'); up.type = 'button'; up.textContent = '\\u2191'; up.title = 'Move up';
    const dn = document.createElement('button'); dn.type = 'button'; dn.textContent = '\\u2193'; dn.title = 'Move down';
    const del = document.createElement('button'); del.type = 'button'; del.textContent = '\\u00d7'; del.title = 'Remove block'; del.className = 'del';
    up.addEventListener('click', () => { if (i > 0) { blocks.splice(i - 1, 0, blocks.splice(i, 1)[0]); renderCanvas(); syncFromBlocks(); } });
    dn.addEventListener('click', () => { if (i < blocks.length - 1) { blocks.splice(i + 1, 0, blocks.splice(i, 1)[0]); renderCanvas(); syncFromBlocks(); } });
    del.addEventListener('click', () => { blocks.splice(i, 1); renderCanvas(); syncFromBlocks(); });
    ops.appendChild(up); ops.appendChild(dn); ops.appendChild(del);
    row.appendChild(grip); row.appendChild(body); row.appendChild(ops);
    row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(i)); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); canvasEl.querySelectorAll('.blk').forEach(x => x.classList.remove('drop-above', 'drop-below')); });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      row.classList.toggle('drop-above', above);
      row.classList.toggle('drop-below', !above);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      const from = +e.dataTransfer.getData('text/plain');
      if (isNaN(from) || from === i) return;
      const r = row.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      const moved = blocks.splice(from, 1)[0];
      let to = above ? i : i + 1;
      if (from < to) to--;
      blocks.splice(to, 0, moved);
      renderCanvas(); syncFromBlocks();
    });
    canvasEl.appendChild(row);
  });
}
for (const type of Object.keys(BLOCK_DEFS)) {
  const el = document.createElement('span');
  el.className = 'pal'; el.textContent = '+ ' + BLOCK_DEFS[type].label;
  el.title = BLOCK_DEFS[type].hint;
  el.addEventListener('click', () => {
    blocks.push({ type, props: Object.assign({}, BLOCK_DEFS[type].props) });
    renderCanvas(); syncFromBlocks();
  });
  paletteEl.appendChild(el);
}
// Parse existing b-html into blocks; unparseable markup switches to HTML mode untouched.
function syncFromHTML() {
  const parsed = htmlToBlocks(htmlEl.value);
  if (parsed === null) { setMode('html'); return; }
  blocks = parsed;
  setMode('visual');
  renderCanvas(); syncFromBlocks();
}
let mode = 'visual';
function setMode(m) {
  mode = m;
  document.getElementById('mode-visual').classList.toggle('on', m === 'visual');
  document.getElementById('mode-html').classList.toggle('on', m === 'html');
  document.getElementById('visualeditor').style.display = m === 'visual' ? '' : 'none';
  htmlEl.style.display = m === 'html' ? '' : 'none';
}
document.getElementById('mode-visual').addEventListener('click', () => syncFromHTML());
htmlEl.addEventListener('input', () => { previewEl.innerHTML = htmlEl.value; });
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
  syncFromHTML();
  document.getElementById('b-starts').value = v.starts_at ? new Date(v.starts_at).toISOString().slice(0,16) : '';
  document.getElementById('b-ends').value = v.ends_at ? new Date(v.ends_at).toISOString().slice(0,16) : '';
  document.getElementById('b-msg').textContent = 'Editing "' + v.name + '". Create saves as a new variant; pause the old one.';
  document.getElementById('builder').scrollIntoView({ behavior: 'smooth' });
}

async function load() {
  const [variants, stats] = await Promise.all([
    fetch('/api/variants?site=' + site).then(r => r.json()),
    fetch('/api/stats?site=' + site).then(r => r.json()),
  ]);
  const byId = Object.fromEntries(stats.variants.map(s => [s.id, s]));
  document.getElementById('holdout').textContent = stats.holdoutPct + '% of traffic held out as control';
  const planEl = document.getElementById('planuse'), warnEl = document.getElementById('overlimit');
  planEl.textContent = ''; warnEl.textContent = '';
  if (stats.plan) {
    let t = '· plan: ' + stats.plan;
    if (stats.usage) {
      t += ' · ' + Number(stats.usage.visitors).toLocaleString() + ' / ' +
        (stats.usage.visitorCap == null ? '∞' : Number(stats.usage.visitorCap).toLocaleString()) + ' visitors this month';
      if (stats.usage.overLimit) warnEl.textContent = 'over plan cap — personalization paused, tracking continues';
    }
    planEl.textContent = t;
  }
  const segEl = document.getElementById('segments');
  segEl.innerHTML = '';
  if (stats.segments && typeof stats.segments === 'object') {
    const fields = Object.keys(stats.segments);
    if (!fields.length) {
      segEl.innerHTML = '<p style="color:#777">No visitor traits yet — send <code>prism.identify({...})</code> from your site.</p>';
    }
    for (const f of fields) {
      const chips = Object.entries(stats.segments[f]).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([v, n]) => '<span class="segchip">' + esc(v) + '<b>×' + n + '</b></span>').join('');
      const row = document.createElement('div');
      row.className = 'segrow';
      row.innerHTML = '<span class="segfield">' + esc(f) + '</span>' + chips;
      segEl.appendChild(row);
    }
  }
  const c = stats.control;
  const liftDiv = document.getElementById('lift');
  if (c.impressions > 0) {
    const treated = stats.variants.reduce((a, s) => ({ i: a.i + s.impressions, c: a.c + s.conversions }), { i: 0, c: 0 });
    const tr = treated.i ? treated.c / treated.i : 0, cr = c.conversions / c.impressions;
    liftDiv.style.display = 'flex';
    liftDiv.innerHTML = '<div class="lift-num">' + (cr ? ((tr/cr - 1) * 100).toFixed(0) : '∞') + '%</div>' +
      '<div class="lift-body"><b>Incremental lift vs holdout</b><br>personalized ' + (100*tr).toFixed(1) + '% (' + treated.i.toLocaleString() + ' impressions) vs control ' + (100*cr).toFixed(1) + '% (' + c.impressions.toLocaleString() + ')</div>';
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
      '<td>' + s.impressions.toLocaleString() + '<div class="bar" style="width:' + (100 * s.impressions / maxImp) + '%"></div></td>' +
      '<td>' + s.conversions.toLocaleString() + '</td>' +
      '<td class="rate">' + (s.rate != null ? (100*s.rate).toFixed(1) + '%' : '—') + ' <span class="ci">' + fmtCI(s.ci95) + '</span></td>' +
      '<td>' + status + '</td>' +
      '<td><div class="row-actions"><button data-edit="' + v.id + '">Edit</button>' +
      '<button onclick="toggle(' + v.id + ')">' + (v.active ? 'Pause' : 'Resume') + '</button>' +
      '<button class="danger" onclick="del(' + v.id + ')">Delete</button></div></td>';
    tb.appendChild(tr);
    tr.querySelector('[data-edit]').addEventListener('click', () => editVariant(v));
  }
  // control row
  if (c.impressions > 0) {
    const tr = document.createElement('tr');
    tr.className = 'control-row';
    tr.innerHTML = '<td>Control (holdout)</td><td>—</td><td>—</td>' +
      '<td>' + c.impressions.toLocaleString() + '<div class="bar ctrl" style="width:' + (100 * c.impressions / maxImp) + '%"></div></td>' +
      '<td>' + c.conversions.toLocaleString() + '</td>' +
      '<td class="rate">' + (c.rate != null ? (100*c.rate).toFixed(1) + '%' : '—') + ' <span class="ci">' + fmtCI(c.ci95) + '</span></td>' +
      '<td colspan="2"></td>';
    tb.appendChild(tr);
  }
}
async function toggle(id) { await authFetch('/api/variants/' + id + '/toggle', { method: 'POST' }); load(); }
async function del(id) { if (confirm('Delete variant?')) { await authFetch('/api/variants/' + id, { method: 'DELETE' }); load(); } }
function authFetch(url, opts) {
  opts = opts || {};
  if (token) url += (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
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
