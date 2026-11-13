/* DX Award Map - web interface. Served by DXAwardMap.exe on http://localhost.
   Data: /api/data (QSO rows from the log), /data/*.json (DXCC list, world map), /packs/<id>/* (award packs). */
'use strict';

// ---------------------------------------------------------------- constants & helpers
const BAND_ORDER = ['2190', '630', '160', '80', '60', '40', '30', '20', '17', '15', '12', '10', '6', '4', '2', '1.25', '70cm', '33cm', '23cm', '13cm', '9cm', '6cm', '3cm'];
const HF = new Set(['2190', '630', '160', '80', '60', '40', '30', '20', '17', '15', '12', '10', '6']);
const bandLabel = b => /cm$/.test(b) ? b : b + ' m';
const FLAGTXT = { 1: 'Code outside call area', 2: 'Code fields disagree', 4: 'Code not in award list', 8: 'QSO after area was deleted', 16: 'Tokyo ward before Apr 2010' };
const SOFT = 1 | 2 | 16, HARD = 4 | 8;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString();
async function getJSON(url, opts) { const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts)); if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); }
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
// d3 wants polygon rings wound clockwise (GeoJSON files are usually the other way round). A polygon wound
// the "wrong" way covers the whole globe except itself, so reverse any polygon larger than a hemisphere.
function rewind(f) {
  const g = f.geometry; if (!g) return f;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const p of polys) if (d3.geoArea({ type: 'Polygon', coordinates: p }) > 2 * Math.PI) p.forEach(r => r.reverse());
  return f;
}

// ---------------------------------------------------------------- state
const S = { view: 'world', pack: null, tab: 'map', band: 'all', status: 'w', op: 'ALL', award: 'ALL', sus: false, del: false, region: null, sel: null, q: '', sort: {} };
let CFG = { ui: {}, mapping: {}, source: 'n3fjp' };
let META = {}, Q = [], BANDS = [], OPS = [], LIVE = 'wait';
let DXCC = [], DXBY = new Map(), WORLD = null, PACKS = [], PACKBY = new Map();
const packCache = new Map();   // id -> loaded pack (definition, entities, map)

const uiPref = (k, d) => (CFG.ui && k in CFG.ui) ? CFG.ui[k] : d;
const confirmOn = () => uiPref('confirm', { L: true, E: true, C: true });
function isConf(q) { if (!q.conf) return false; if (q.conf.includes('Q')) return true; const c = confirmOn(); for (const ch of q.conf) if (c[ch]) return true; return false; }
const opOk = q => S.op === 'ALL' || q.op === S.op;
const bandOk = q => S.band === 'all' || q.band === S.band;

// ---------------------------------------------------------------- data loading
function loadRows(data) {
  META = data.meta || {};
  const cols = META.columns || [];
  const extra = cols.slice(8);
  const bandSet = new Set(), opSet = new Set();
  Q = (data.rows || []).map((r, i) => {
    const f = {}; for (let k = 0; k < extra.length; k++) f[extra[k]] = r[8 + k];
    const q = { i, key: r[0], call: r[1], date: r[2], band: r[3], mode: r[4], dxcc: r[5], conf: r[6], op: r[7] || '?', f };
    if (q.band) bandSet.add(q.band); if (q.op && q.op !== '?') opSet.add(q.op);
    return q;
  });
  const vhf = uiPref('vhf', false);
  BANDS = BAND_ORDER.filter(b => bandSet.has(b) && (vhf || HF.has(b)));
  OPS = [...opSet].sort();
  if (S.band !== 'all' && !BANDS.includes(S.band)) S.band = 'all';
  if (S.op !== 'ALL' && !OPS.includes(S.op)) S.op = 'ALL';
  for (const p of packCache.values()) p.processed = null;
  worldCache = null;
}
async function fetchData() { loadRows(await getJSON('/api/data')); }

// ---------------------------------------------------------------- world statistics
let worldCache = null;
function worldStats() {
  const key = [S.op, uiPref('confirm', null) && JSON.stringify(confirmOn())].join('|');
  if (worldCache && worldCache.key === key) return worldCache.st;
  const st = new Map(); // dxcc -> { b: Map(band -> {w, c, q}) }
  for (const q of Q) {
    if (!q.dxcc || !opOk(q) || !BANDS.includes(q.band)) continue;
    let s = st.get(q.dxcc); if (!s) { s = { b: new Map() }; st.set(q.dxcc, s); }
    let bb = s.b.get(q.band); if (!bb) { bb = { w: 0, c: 0, q: null }; s.b.set(q.band, bb); }
    bb.w++; const c = isConf(q); if (c) bb.c++;
    if (!bb.q || (c && !isConf(bb.q)) || (c === isConf(bb.q) && q.date < bb.q.date)) bb.q = q;
  }
  worldCache = { key, st }; return st;
}
function dxStatus(dx, band = S.band) { // 0 none, 1 worked, 2 confirmed
  const s = worldStats().get(dx); if (!s) return 0;
  let r = 0;
  for (const [b, v] of s.b) { if (band !== 'all' && b !== band) continue; if (v.c) return 2; if (v.w) r = 1; }
  return r;
}
const counted = st => S.status === 'c' ? st === 2 : st > 0;

// ---------------------------------------------------------------- packs: load + process QSOs
async function loadPack(id) {
  if (packCache.has(id)) return packCache.get(id);
  const def = await getJSON(`/packs/${id}/pack.json`);
  const er = await fetch(`/packs/${id}/entities.json`, { cache: 'no-store' });
  if (er.status === 404 && def.list) { const e = new Error('list-missing'); e.def = def; throw e; }
  if (!er.ok) throw new Error(`/packs/${id}/entities.json: ${er.status}`);
  const ent = await er.json();
  let map = null, entityMap = null;
  if (def.map) map = await getJSON(`/packs/${id}/${def.map.file}`);
  if (def.entityMap) entityMap = def.entityMap.file === def.map?.file ? map : await getJSON(`/packs/${id}/${def.entityMap.file}`);
  const ents = ent.e.map(([c, n, t, r, d, par, x]) => ({ c, n, t, r, d, par, x: !!x }));
  const byKey = new Map(ents.map(e => [e.t + ':' + e.c, e]));
  const p = { id, def, ents, byKey, map, entityMap, meta: ent.meta || null, regionName: new Map(def.regions.map(r => [r[0], r[1]])), processed: null };
  packCache.set(id, p); return p;
}

// normalisation steps named in pack.json
const NORM = {
  trim: v => v.trim(), upper: v => v.toUpperCase(), nospace: v => v.replace(/[\s-]+/g, ''),
  rda: v => { const m = v.toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{2})-?([0-9O]{2})$/); return m ? m[1] + '-' + m[2].replace(/O/g, '0') : v.toUpperCase(); },
  county: v => {
    let [st, ...rest] = v.split(','); let c = rest.join(',');
    if (!c) return v.toUpperCase();
    c = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/&/g, 'AND').replace(/\bSAINT\b/g, 'ST')
      .replace(/\bCITY AND BOROUGH\b/g, '').replace(/\bCENSUS AREA\b/g, '').replace(/\b(COUNTY|PARISH|BOROUGH|MUNICIPALITY)\b/g, '');
    return st.trim().toUpperCase() + ',' + c.replace(/[^A-Z0-9]/g, '');
  },
};
function sourcesFor(p, award) { // user mapping overrides pack defaults
  const key = p.id + '/' + (award ? award.id : '*');
  if (CFG.mapping && Array.isArray(CFG.mapping[key])) return CFG.mapping[key];
  const src = award ? award.sources : p.def.codeSources;
  return src ? (src[CFG.source] || []) : null;
}
function extract(p, q, sources, steps) { // -> list of distinct codes found
  const out = [];
  for (const s of sources) {
    let v = q.f[s.field]; if (v == null || v === '') continue;
    v = String(v);
    if (s.with) { const w = q.f[s.with]; if (!v.includes(',')) { if (!w) continue; v = w + ',' + v; } }
    if (s.re) { let m; try { m = v.match(new RegExp(s.re, 'i')); } catch (e) { m = null; } if (!m) continue; v = m[1] ?? m[0]; }
    v = v.trim(); if (!v) continue;
    for (const st of steps) { if (st === 'alias') { const a = p.def.aliases || {}; v = a[v.toUpperCase()] || v; } else if (NORM[st]) v = NORM[st](v); }
    if ((p.def.nullTokens || []).includes(v.toUpperCase())) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}
function callArea(call) {
  const parts = call.split('/'); const base = parts.slice().sort((a, b) => b.length - a.length)[0];
  const sfx = parts.filter(x => x !== base);
  const d = sfx.find(x => /^\d$/.test(x)); if (d) return +d;
  if (sfx.length) return -1; // /P, /M, /QRP ...: may be anywhere
  let m = base.match(/^7[K-N]([1-4])/); if (m) return 1;
  m = base.match(/^\d[A-Z](\d)/) || base.match(/^[A-Z]{1,2}(\d)/); return m ? +m[1] : -1;
}
function processPack(p) {
  if (p.processed) return p.processed;
  const dx = new Set(p.def.dxcc);
  const awards = p.def.awards;
  const shared = awards.filter(a => !a.sources);
  const own = awards.filter(a => a.sources);
  const cov = new Map(); // entity key -> [qsos]
  const credit = (e, q) => { const k = e.t + ':' + e.c; let a = cov.get(k); if (!a) cov.set(k, a = []); a.push(q); };
  const sus = [], missing = [], recs = [];
  const sharedSrc = shared.length ? sourcesFor(p, null) || [] : [];
  for (const q of Q) {
    if (!dx.has(q.dxcc)) continue;
    const found = []; let flags = 0, any = false, codes = [];
    if (shared.length) {
      const cs = extract(p, q, sharedSrc, p.def.normalize || ['trim']);
      if (cs.length) any = true; if (cs.length > 1) flags |= 2; codes = codes.concat(cs);
      for (const c of cs) { const e = shared.map(a => p.byKey.get(a.id + ':' + c)).find(Boolean); if (e) { found.push(e); break; } }
    }
    for (const a of own) {
      const cs = extract(p, q, sourcesFor(p, a), a.normalize || p.def.normalize || ['trim']);
      if (!cs.length) continue; any = true; if (cs.length > 1 && !a.derived) flags |= 2; codes = codes.concat(cs);
      const e = cs.map(c => p.byKey.get(a.id + ':' + c)).find(Boolean); if (e) found.push(e);
    }
    if (!any) { missing.push(q); continue; }
    const main = found.find(e => !awards.find(a => a.id === e.t)?.derived) || found[0];
    if (!found.length) flags |= 4;
    for (const e of found) {
      if (e.d && q.date > e.d) { if (e === main) flags |= 8; continue; }
      credit(e, q);
      if (p.def.creditParent && e.par) for (const a of awards) { const pe = p.byKey.get(a.id + ':' + e.par); if (pe && (!pe.d || q.date <= pe.d)) credit(pe, q); }
    }
    if (main && p.def.callArea) { const exp = p.def.callArea[main.r]; const ca = callArea(q.call); if (exp != null && ca >= 0 && ca !== exp && !(q.call.startsWith('JD1') && main.r === '10')) flags |= 1; }
    if (main && (p.def.rules || []).includes('ja-tokyo-wards') && /^1001\d\d$/.test(main.c) && q.date < '2010-04-01') {
      flags |= 16; const t = p.byKey.get('JCC:1001'); if (t && q.date <= t.d) credit(t, q);
    }
    const rec = { q, flags, codes: [...new Set(codes)], ent: main };
    q._pk = q._pk || {}; q._pk[p.id] = flags;
    recs.push(rec); if (flags) sus.push(rec);
  }
  p.processed = { cov, sus, missing, recs };
  return p.processed;
}
function rank(p, a, b) { const fa = a._pk?.[p.id] || 0, fb = b._pk?.[p.id] || 0; return (isConf(b) - isConf(a)) || ((fa & SOFT ? 1 : 0) - (fb & SOFT ? 1 : 0)) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); }
function best(p, e, band = S.band) {
  const list = processPack(p).cov.get(e.t + ':' + e.c); if (!list) return null;
  let r = null;
  for (const q of list) {
    if (!opOk(q) || (band !== 'all' && q.band !== band) || !BANDS.includes(q.band)) continue;
    if (S.sus && ((q._pk?.[p.id] || 0) & SOFT)) continue;
    if (S.status === 'c' && !isConf(q)) continue;
    if (!r || rank(p, q, r) < 0) r = q;
  }
  return r;
}
const inAward = e => S.award === 'ALL' || e.t === S.award;
function stats(p, list, band = S.band) {
  const s = { cur: 0, got: 0, del: 0, delGot: 0 };
  for (const e of list) { if (!inAward(e)) continue; const g = !!best(p, e, band); if (e.x) { s.del++; if (g) s.delGot++; } else { s.cur++; if (g) s.got++; } }
  return s;
}

// ---------------------------------------------------------------- tooltip
const tip = $('tip');
function showTip(ev, html) { tip.innerHTML = html; tip.hidden = false; moveTip(ev); }
function moveTip(ev) { const r = tip.getBoundingClientRect(); let x = ev.clientX + 14, y = ev.clientY + 14; if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14; if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14; tip.style.left = x + 'px'; tip.style.top = y + 'px'; }
function hideTip() { tip.hidden = true; }
const CONFNAME = { L: 'LoTW', E: 'eQSL', C: 'card', Q: 'QSL' };
function qsoTip(q, extra = '') {
  return `<b class="t-mono">${esc(q.call)}</b> &middot; ${esc(bandLabel(q.band))} &middot; ${esc(q.mode)}<br>${esc(q.date)} &middot; op ${esc(q.op)}<br>` +
    (isConf(q) ? 'Confirmed (' + q.conf.split('').map(c => CONFNAME[c]).join(', ') + ')' : q.conf ? 'Confirmed by ' + q.conf.split('').map(c => CONFNAME[c]).join(', ') + ' (not counted in Settings)' : 'Not confirmed') +
    extra + `<br><span style="opacity:.7">Log record ${esc(q.key)}</span>`;
}
document.addEventListener('mouseover', ev => {
  const d = ev.target.closest && ev.target.closest('[data-q]');
  if (d) { const q = Q[+d.dataset.q]; showTip(ev, qsoTip(q, d.dataset.x ? '<br>' + d.dataset.x : '')); }
});
document.addEventListener('mousemove', ev => { if (!tip.hidden && ev.target.closest && ev.target.closest('[data-q]')) moveTip(ev); });
document.addEventListener('mouseout', ev => { if (ev.target.closest && ev.target.closest('[data-q]')) hideTip(); });

// ---------------------------------------------------------------- shared UI pieces
function seg(id, items, key, after) {
  d3.select('#' + id).selectAll('button').data(items, d => d[0]).join('button').text(d => d[1]).attr('aria-pressed', d => S[key] === d[0])
    .on('click', (ev, d) => { S[key] = d[0]; if (after) after(d[0]); render(); });
}
function sortable(id, cols, rows, defKey, defDir = 1) {
  const st = S.sort[id] || (S.sort[id] = { k: defKey, d: defDir });
  const col = cols.find(c => c.k === st.k) || cols[0];
  rows.sort((a, b) => { const x = col.v(a), y = col.v(b); return (x < y ? -1 : x > y ? 1 : 0) * st.d; });
  return `<thead><tr>${cols.map(c => `<th class="${c.k ? 'sortable' : ''}${c.num ? ' num' : ''}" data-k="${c.k || ''}">${c.h}${st.k === c.k && c.k ? (st.d > 0 ? ' &#9650;' : ' &#9660;') : ''}</th>`).join('')}</tr></thead>`;
}
function bindSort(el, id, redraw) { el.querySelectorAll('th.sortable').forEach(th => th.onclick = () => { const st = S.sort[id]; if (st.k === th.dataset.k) st.d *= -1; else { st.k = th.dataset.k; st.d = 1; } redraw(); }); }
const dotHtml = (q, flagged) => q ? `<span class="dot ${isConf(q) ? 'c' : 'w'}${flagged ? ' f' : ''}" data-q="${q.i}"></span>` : '';
const bins = [0.2, 0.4, 0.6, 0.8, 1];
function rampFill(share, cur) { if (!cur) return 'var(--surface-2)'; if (share <= 0) return 'var(--empty)'; const i = bins.findIndex(t => share < t); return i < 0 ? 'var(--r6)' : `var(--r${i + 1})`; }
const isDark = () => getComputedStyle(document.documentElement).colorScheme.includes('dark');
function labelInk(share) { if (share <= 0) return 'var(--ink-2)'; const i = share >= 1 ? 6 : bins.findIndex(t => share < t) + 1; return isDark() ? (i >= 4 ? '#0e1115' : '#ffffff') : (i >= 4 ? '#ffffff' : '#111820'); }
const rampLegend = what => `<span>Share of current ${what} ${S.status === 'c' ? 'confirmed' : 'worked'}</span><span><span class="ramp">${['empty', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map(v => `<i style="background:var(--${v})"></i>`).join('')}</span><span class="ramp-l"><span>0</span><span>20</span><span>40</span><span>60</span><span>80</span><span>100%</span></span></span><span><span class="sw" style="box-shadow:inset 0 0 0 2px var(--gold)"></span>Complete</span>`;
function projectionFor(spec, w, h, fitObj) {
  let pr;
  if (spec && spec.name === 'albersUsa') pr = d3.geoAlbersUsa();
  else if (spec && spec.name === 'conicEqualArea') pr = d3.geoConicEqualArea().rotate(spec.rotate || [0, 0]).parallels(spec.parallels || [30, 60]);
  else if (spec && spec.name === 'naturalEarth') pr = d3.geoNaturalEarth1();
  else pr = d3.geoMercator();
  return pr.fitExtent([[12, 12], [w - 12, h - 12]], fitObj);
}
function zoomable(svg, g, w, h, onZoom) {
  const z = d3.zoom().scaleExtent([1, 40]).translateExtent([[0, 0], [w, h]]).on('zoom', ev => { g.attr('transform', ev.transform); onZoom && onZoom(ev.transform.k); });
  svg.call(z).on('dblclick.zoom', null);
  return () => svg.transition().duration(matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 500).call(z.transform, d3.zoomIdentity);
}

// ---------------------------------------------------------------- header, filters, tabs
function header() {
  const st = LIVE === 'ok' ? '<span class="live">Live</span>' : LIVE === 'wait' ? '<span class="live wait">Reading log&hellip;</span>' : '<span class="live off">Program not responding</span>';
  let txt = '';
  if (META.status === 'error') txt = `<span class="err">Could not read the log: ${esc(META.error)}</span> &middot; <a href="#settings">Settings</a>`;
  else if (META.status === 'ok') txt = `${META.source === 'adif' ? 'ADIF file' : 'N3FJP log'} <span class="mono">${esc(META.file)}</span>, read ${esc(META.read)} &middot; ${fmt(Q.length)} QSOs`;
  $('sub').innerHTML = `${st} ${txt}`;
  $('nav-world').setAttribute('aria-current', S.view === 'world' ? 'page' : 'false');
  $('nav-settings').setAttribute('aria-current', S.view === 'settings' ? 'page' : 'false');
  const sel = $('countrysel');
  if (!sel.options.length) {
    // every DXCC entity; a country with award packs gets one entry per award, the others open their country page
    const opt = d => {
      const packs = PACKS.filter(p => p.dxcc.includes(d.n));
      const base = `${esc(d.name)} (${esc(d.pfx || d.n)})`;
      if (!packs.length) return `<option value="dx-${d.n}">${base}</option>`;
      return packs.map(p => `<option value="${p.id}">${base} &ndash; ${esc(p.title)}</option>`).join('');
    };
    const byName = (a, b) => a.name.localeCompare(b.name);
    sel.innerHTML = '<option value="">Choose a country&hellip;</option>' +
      `<optgroup label="DXCC entities (${DXCC.filter(d => !d.del).length})">${DXCC.filter(d => !d.del).sort(byName).map(opt).join('')}</optgroup>` +
      `<optgroup label="Deleted entities">${DXCC.filter(d => d.del).sort(byName).map(d => `<option value="dx-${d.n}">${esc(d.name)} (deleted)</option>`).join('')}</optgroup>`;
    sel.onchange = () => { if (sel.value) location.hash = sel.value; };
  }
  sel.value = S.view === 'pack' ? S.pack : S.view === 'dx' ? 'dx-' + S.dx : ''; sel.classList.toggle('on', S.view === 'pack' || S.view === 'dx');
}
function filters() {
  $('filters').hidden = S.view === 'settings';
  seg('f-band', [['all', 'All']].concat(BANDS.map(b => [b, b.replace('cm', 'cm')])), 'band');
  seg('f-status', [['w', 'Worked'], ['c', 'Confirmed']], 'status');
  $('fg-op').hidden = OPS.length < 2;
  seg('f-op', [['ALL', 'All']].concat(OPS.map(o => [o, o])), 'op');
  const p = S.view === 'pack' ? packCache.get(S.pack) : null;
  $('fg-award').hidden = !p || p.def.awards.length < 2;
  if (p) seg('f-award', [['ALL', 'All']].concat(p.def.awards.map(a => [a.id, a.name])), 'award', () => { S.region = null; });
  $('fg-sus').hidden = $('fg-del').hidden = !p;
  $('f-sus').checked = S.sus; $('f-del').checked = S.del;
}
$('f-sus').onchange = e => { S.sus = e.target.checked; render(); };
$('f-del').onchange = e => { S.del = e.target.checked; render(); };
function tabs(list) {
  $('tabs').hidden = !list;
  if (list) $('tabs').innerHTML = list.map(([id, label, badge]) => `<a href="${tabHref(id)}" aria-current="${S.tab === id ? 'page' : 'false'}">${label}${badge != null ? `<span class="badge">${fmt(badge)}</span>` : ''}</a>`).join('');
}
const tabHref = t => '#' + (S.view === 'world' ? 'world' : S.view === 'dx' ? 'dx-' + S.dx : S.pack) + (t === 'map' ? '' : '--' + t);

// ---------------------------------------------------------------- WORLD view
function worldTotals() {
  const cur = DXCC.filter(d => !d.del);
  let w = 0, c = 0; for (const d of cur) { const s = dxStatus(d.n); if (s) w++; if (s === 2) c++; }
  const del = DXCC.filter(d => d.del && dxStatus(d.n)).length;
  const perBand = BANDS.map(b => { let n = 0; for (const d of cur) if (counted(dxStatus(d.n, b))) n++; return [b, n]; });
  $('totals').innerHTML = `<div class="tot"><span class="k">DXCC &middot; ${S.band === 'all' ? 'all bands' : bandLabel(S.band)}</span><span class="v">${w}<small> / ${cur.length} worked</small></span><span class="d">${c} confirmed${del ? ` &middot; +${del} deleted` : ''}</span></div>` +
    `<div class="tot" style="flex:1"><span class="k">${S.status === 'c' ? 'Confirmed' : 'Worked'} DXCC per band</span><span class="d" style="display:flex;gap:10px;flex-wrap:wrap;font-size:13px">${perBand.map(([b, n]) => `<span><b>${b}</b> ${n}</span>`).join('')}</span></div>`;
}
function renderWorld() {
  worldTotals();
  const needed = DXCC.filter(d => !d.del && !counted(dxStatus(d.n))).length;
  tabs([['map', 'Map'], ['entities', 'Entities', DXCC.filter(d => !d.del).length], ['needed', 'Still needed', needed], ['bands', 'By band']]);
  const v = $('view');
  if (S.tab === 'entities' || S.tab === 'needed') return worldTable(v, S.tab === 'needed');
  if (S.tab === 'bands') return worldBands(v);
  v.innerHTML = `<section class="split world"><div class="card mapcard"><div class="maptools"><button class="btn small" id="wreset">Reset zoom</button><span class="note">Scroll to zoom, drag to pan, click a country</span></div><svg id="wmap" class="map" viewBox="0 0 960 500" role="img" aria-label="World map of DXCC entities"></svg><div class="legend"><span><span class="sw" style="background:var(--accent)"></span>Confirmed</span><span><span class="sw" style="background:var(--worked)"></span>Worked</span><span><span class="sw" style="background:var(--empty)"></span>Not worked</span><span class="note">Small entities are shown as dots</span></div></div><div class="card panel" id="wpanel"></div></section>`;
  drawWorldMap($('wmap'), 960, 500, S.band, true);
  worldPanel();
}
const statusFill = s => s === 2 ? 'var(--accent)' : s === 1 ? (S.status === 'c' ? 'var(--empty)' : 'var(--worked)') : 'var(--empty)';
let worldProj = null;
function drawWorldMap(svgEl, w, h, band, interactive) {
  const svg = d3.select(svgEl); svg.selectAll('*').remove();
  const proj = d3.geoNaturalEarth1().fitExtent([[6, 6], [w - 6, h - 6]], { type: 'Sphere' });
  const path = d3.geoPath(proj); if (interactive) worldProj = proj;
  const g = svg.append('g');
  g.append('path').datum({ type: 'Sphere' }).attr('d', path).attr('fill', 'var(--sea)');
  g.selectAll('path.shape').data(WORLD.features).join('path').attr('class', f => 'shape' + (f.properties.dx ? (interactive ? ' click' : '') : ' bg')).attr('d', path)
    .attr('fill', f => f.properties.dx ? statusFill(dxStatus(f.properties.dx, band)) : null)
    .classed('sel', f => interactive && f.properties.dx === S.sel);
  const dots = DXCC.filter(d => !d.del && !d.shape && d.lat != null);
  const k0 = interactive ? 1 : 0.7;
  const dsel = g.selectAll('circle.dxdot').data(dots).join('circle').attr('class', 'dxdot').attr('r', 3.2 * k0)
    .attr('cx', d => proj([d.lon, d.lat])[0]).attr('cy', d => proj([d.lon, d.lat])[1]).attr('fill', d => statusFill(dxStatus(d.n, band)));
  if (!interactive) { dsel.style('pointer-events', 'none'); return; }
  const tipFor = dx => { const d = DXBY.get(dx); if (!d) return ''; const s = worldStats().get(dx); const bands = BANDS.filter(b => s && s.b.get(b)).map(b => `${b}${s.b.get(b).c ? '&#10003;' : ''}`).join(' '); const packs = PACKS.filter(p => p.dxcc.includes(dx)); return `<b>${esc(d.name)}</b> <span style="opacity:.7">${esc(d.pfx)} &middot; DXCC ${d.n}</span><br>${bands ? 'Bands: ' + bands : 'Not worked'}${packs.length ? '<br>Click for ' + packs.map(p => esc(p.title)).join(', ') : ''}`; };
  g.selectAll('path.shape.click').on('mouseenter', (ev, f) => showTip(ev, tipFor(f.properties.dx))).on('mousemove', moveTip).on('mouseleave', hideTip).on('click', (ev, f) => selectDx(f.properties.dx));
  dsel.on('mouseenter', (ev, d) => showTip(ev, tipFor(d.n))).on('mousemove', moveTip).on('mouseleave', hideTip).on('click', (ev, d) => selectDx(d.n));
  const reset = zoomable(svg, g, w, h, k => dsel.attr('r', 3.2 / Math.sqrt(k)));
  $('wreset').onclick = reset;
}
function selectDx(dx) { S.sel = S.sel === dx ? null : dx; hideTip(); renderWorld(); }
function dxBandTable(n) {
  const s = worldStats().get(n);
  return `<table class="mx"><thead><tr><th>Band</th><th class="num">QSOs</th><th class="num">Confirmed</th><th>Best QSO</th></tr></thead><tbody>
    ${BANDS.map(b => { const v = s && s.b.get(b); return `<tr${S.band === b ? ' class="sel"' : ''}><td><b>${bandLabel(b)}</b></td><td class="num">${v ? v.w : ''}</td><td class="num">${v ? v.c : ''}</td><td>${v ? `${dotHtml(v.q)} <span class="mono">${esc(v.q.call)}</span> <span class="note">${esc(v.q.date)} ${esc(v.q.mode)}</span>` : '<span class="note">not worked</span>'}</td></tr>`; }).join('')}
    </tbody></table>`;
}
const awardButtons = n => { const packs = PACKS.filter(p => p.dxcc.includes(n)); return packs.length ? `<div class="toolbar"><span class="note">Awards:</span>${packs.map(p => `<a class="btn small" href="#${p.id}">${esc(p.title)}</a>`).join('')}</div>` : ''; };
function worldPanel() {
  const el = $('wpanel');
  if (S.sel) {
    const d = DXBY.get(S.sel);
    el.innerHTML = `<div class="phead"><h2>${esc(d.name)}</h2><span class="note mono">${esc(d.pfx)} &middot; DXCC ${d.n} &middot; ${esc(d.cont)}</span></div>
      ${awardButtons(d.n)}${dxBandTable(d.n)}
      <div class="toolbar"><a class="btn small" href="#dx-${d.n}">Country page with all QSOs</a><button class="btn small" id="wback">All entities</button></div>`;
    $('wback').onclick = () => { S.sel = null; renderWorld(); };
    return;
  }
  const conts = d3.rollups(DXCC.filter(d => !d.del), v => ({ cur: v.length, got: v.filter(d => counted(dxStatus(d.n))).length }), d => d.cont || '?').sort((a, b) => a[0].localeCompare(b[0]));
  el.innerHTML = `<div class="phead"><h2>By continent</h2><span class="note">Click a country on the map for its band details and awards</span></div>
    <table><thead><tr><th>Continent</th><th>Progress</th><th class="num">${S.status === 'c' ? 'Confirmed' : 'Worked'}</th><th class="num">Entities</th></tr></thead><tbody>
    ${conts.map(([c, v]) => `<tr><td><b>${esc(c)}</b></td><td><span class="bar"><i style="width:${pct(v.got, v.cur)}%"></i></span>${pct(v.got, v.cur)}%</td><td class="num">${v.got}</td><td class="num">${v.cur}</td></tr>`).join('')}
    </tbody></table>
    <h3>Award packs in your log</h3>
    <table><thead><tr><th>Country</th><th>Award</th><th class="num">QSOs</th></tr></thead><tbody>
    ${PACKS.map(p => [p, Q.filter(q => p.dxcc.includes(q.dxcc)).length]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([p, n]) => `<tr class="click" data-p="${p.id}"><td>${esc(p.name)}</td><td>${esc(p.title)}</td><td class="num">${fmt(n)}</td></tr>`).join('')}
    </tbody></table>`;
  el.querySelectorAll('tr[data-p]').forEach(tr => tr.onclick = () => { location.hash = tr.dataset.p; });
}
function worldTable(v, onlyNeeded) {
  const rows = DXCC.filter(d => (S.del || !d.del) && (!onlyNeeded || (!d.del && !counted(dxStatus(d.n))))).map(d => ({ d, st: dxStatus(d.n), packs: PACKS.filter(p => p.dxcc.includes(d.n)) }));
  const qq = S.q.toLowerCase();
  const shown = rows.filter(r => !qq || r.d.name.toLowerCase().includes(qq) || r.d.pfx.toLowerCase().includes(qq) || String(r.d.n) === qq);
  const cols = [{ k: 'pfx', h: 'Prefix', v: r => r.d.pfx }, { k: 'name', h: 'Entity', v: r => r.d.name }, { k: 'cont', h: 'Cont.', v: r => r.d.cont }, { k: 'n', h: 'DXCC', v: r => r.d.n, num: true }, { k: 'st', h: 'Status', v: r => -r.st }];
  const head = sortable('world-' + onlyNeeded, cols, shown, 'name');
  const s = worldStats();
  v.innerHTML = `<section class="card tablecard"><div class="phead"><h2>${onlyNeeded ? 'Still needed' : 'All DXCC entities'} &middot; ${S.band === 'all' ? 'all bands' : bandLabel(S.band)}</h2>
    <div class="toolbar"><input class="search" id="wsearch" placeholder="Filter by name, prefix or number" value="${esc(S.q)}"><label class="chk"><input type="checkbox" id="wdel" ${S.del ? 'checked' : ''}> Show deleted entities</label></div></div>
    <div class="tscroll"><table class="mx">${head.replace('</tr></thead>', BANDS.map(b => `<th class="b">${b}</th>`).join('') + '<th>Awards</th></tr></thead>')}<tbody>
    ${shown.map(r => `<tr class="${r.d.del ? 'del' : ''}"><td class="mono">${esc(r.d.pfx)}</td><td class="nm"${r.d.del ? ' data-del="deleted"' : ''}>${esc(r.d.name)}</td><td>${esc(r.d.cont)}</td><td class="num">${r.d.n}</td><td>${r.st === 2 ? 'Confirmed' : r.st === 1 ? 'Worked' : ''}</td>${BANDS.map(b => { const x = s.get(r.d.n)?.b.get(b); return `<td class="b">${x ? dotHtml(x.q) : ''}</td>`; }).join('')}<td>${r.packs.map(p => `<a class="chip pack" href="#${p.id}">${esc(p.awards[0] === 'SUB' ? p.title : p.awards.join(' / '))}</a>`).join(' ')}</td></tr>`).join('')}
    </tbody></table></div></section>`;
  bindSort(v, 'world-' + onlyNeeded, () => worldTable(v, onlyNeeded));
  const ws = $('wsearch'); ws.oninput = () => { S.q = ws.value; const pos = ws.selectionStart; worldTable(v, onlyNeeded); const n = $('wsearch'); n.focus(); n.setSelectionRange(pos, pos); };
  $('wdel').onchange = e => { S.del = e.target.checked; worldTable(v, onlyNeeded); };
}
function worldBands(v) {
  const items = ['all'].concat(BANDS);
  v.innerHTML = `<div class="mini-grid">${items.map(b => { const cur = DXCC.filter(d => !d.del); const n = cur.filter(d => counted(dxStatus(d.n, b))).length; return `<div class="card mini${S.band === b ? ' on' : ''}" data-b="${b}" tabindex="0" role="button"><div class="mh"><b>${b === 'all' ? 'All bands' : bandLabel(b)}</b><span class="num note">${n} / ${cur.length}</span></div><svg viewBox="0 0 480 250" aria-hidden="true"></svg></div>`; }).join('')}</div>`;
  v.querySelectorAll('.mini').forEach(m => { drawWorldMap(m.querySelector('svg'), 480, 250, m.dataset.b, false); const go = () => { S.band = m.dataset.b; location.hash = 'world'; }; m.onclick = go; m.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }; });
}

// ---------------------------------------------------------------- COUNTRY page (any DXCC entity)
function renderDx() {
  const d = DXBY.get(S.dx); if (!d) { location.hash = 'world'; return; }
  const qsos = Q.filter(q => q.dxcc === d.n && opOk(q) && BANDS.includes(q.band));
  const s = worldStats().get(d.n);
  const bw = BANDS.filter(b => s && s.b.get(b)).length, bc = BANDS.filter(b => s && s.b.get(b) && s.b.get(b).c).length;
  const st = dxStatus(d.n, 'all');
  $('totals').innerHTML = `<div class="tot"><span class="k">${esc(d.name)} &middot; DXCC ${d.n}${d.del ? ' &middot; deleted' : ''}</span><span class="v">${st === 2 ? 'Confirmed' : st === 1 ? 'Worked' : 'Not worked'}</span><span class="d">${esc(d.pfx)} &middot; ${esc(d.cont)}</span></div>` +
    `<div class="tot"><span class="k">Bands</span><span class="v">${bw}<small> / ${BANDS.length} worked</small></span><span class="d">${bc} confirmed</span></div>` +
    `<div class="tot"><span class="k">QSOs</span><span class="v">${fmt(qsos.length)}</span><span class="d">${qsos.filter(isConf).length} confirmed</span></div>`;
  tabs([['map', 'Overview'], ['qsos', 'QSOs', qsos.length]]);
  const v = $('view');
  if (S.tab === 'qsos') {
    const rows = qsos.filter(bandOk).filter(q => S.status !== 'c' || isConf(q));
    const cols = [{ k: 'date', h: 'Date', v: r => r.date }, { k: 'call', h: 'Call', v: r => r.call }, { k: 'band', h: 'Band', v: r => BAND_ORDER.indexOf(r.band) }, { k: 'mode', h: 'Mode', v: r => r.mode }, { k: 'conf', h: 'QSL', v: r => r.conf }, { k: 'op', h: 'Operator', v: r => r.op }, { k: 'key', h: 'Log record', v: r => +r.key, num: true }];
    const head = sortable('dxq', cols, rows, 'date', -1);
    v.innerHTML = `<section class="card tablecard"><div class="phead"><h2>QSOs with ${esc(d.name)} &middot; ${S.band === 'all' ? 'all bands' : bandLabel(S.band)}</h2><span class="note">${fmt(rows.length)} QSOs${rows.length > 5000 ? ', first 5,000 shown' : ''}</span></div>
      <div class="tscroll"><table>${head}<tbody>${rows.slice(0, 5000).map(q => `<tr><td class="num">${esc(q.date)}</td><td class="mono">${esc(q.call)}</td><td>${esc(bandLabel(q.band))}</td><td>${esc(q.mode)}</td><td>${q.conf ? dotHtml(q) + ' ' + q.conf.split('').map(c => CONFNAME[c]).join(', ') : ''}</td><td>${esc(q.op)}</td><td class="num">${esc(q.key)}</td></tr>`).join('') || '<tr><td colspan="7" class="note">No QSOs.</td></tr>'}</tbody></table></div></section>`;
    bindSort(v, 'dxq', renderDx);
    return;
  }
  v.innerHTML = `<section class="split"><div class="card mapcard"><svg id="dxmap" class="map" viewBox="0 0 640 460" role="img" aria-label="Map of ${esc(d.name)}"></svg><div class="legend"><span><span class="sw" style="background:var(--accent)"></span>Confirmed</span><span><span class="sw" style="background:var(--worked)"></span>Worked</span><span><span class="sw" style="background:var(--empty)"></span>Not worked</span></div></div>
    <div class="card panel"><div class="phead"><h2>${esc(d.name)}</h2><span class="note mono">${esc(d.pfx)} &middot; DXCC ${d.n} &middot; ${esc(d.cont)}</span></div>${awardButtons(d.n)}${dxBandTable(d.n)}</div></section>`;
  drawDxMap(d, $('dxmap'), 640, 460);
}
function drawDxMap(d, el, W, H) {
  const svg = d3.select(el); svg.selectAll('*').remove();
  const own = WORLD.features.filter(f => f.properties.dx === d.n);
  let proj;
  if (own.length) {
    // zoom to the entity, with some surroundings; small entities get a minimum extent of about 6 degrees
    const b = d3.geoBounds({ type: 'FeatureCollection', features: own });
    const wrap = b[1][0] < b[0][0];
    const cx = wrap ? 180 : (b[0][0] + b[1][0]) / 2, cy = (b[0][1] + b[1][1]) / 2;
    const half = Math.max(3, (wrap ? 360 - b[0][0] + b[1][0] : b[1][0] - b[0][0]) * 0.75, (b[1][1] - b[0][1]) * 0.75);
    proj = d3.geoMercator().rotate([-cx, 0]).fitExtent([[10, 10], [W - 10, H - 10]], { type: 'MultiPoint', coordinates: [[cx - half, Math.max(-80, cy - half * 0.75)], [cx + half, Math.min(84, cy + half * 0.75)]] });
  } else if (d.lat != null) {
    proj = d3.geoMercator().rotate([-d.lon, 0]).fitExtent([[10, 10], [W - 10, H - 10]], { type: 'MultiPoint', coordinates: [[d.lon - 12, d.lat - 8], [d.lon + 12, d.lat + 8]] });
  } else { svg.append('text').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').attr('fill', 'var(--muted)').text('No map position for this entity'); return; }
  const path = d3.geoPath(proj);
  const g = svg.append('g');
  g.append('path').datum({ type: 'Sphere' }).attr('d', path).attr('fill', 'var(--sea)');
  g.selectAll('path.shape').data(WORLD.features).join('path').attr('class', 'shape').attr('d', path)
    .attr('fill', f => f.properties.dx === d.n ? statusFill(dxStatus(d.n)) : 'var(--land)')
    .attr('stroke', f => f.properties.dx === d.n ? 'var(--ink)' : null).attr('stroke-width', f => f.properties.dx === d.n ? 1.5 : null);
  if (!own.length && d.lat != null) {
    const p = proj([d.lon, d.lat]);
    g.append('circle').attr('cx', p[0]).attr('cy', p[1]).attr('r', 9).attr('class', 'dxdot').attr('fill', statusFill(dxStatus(d.n))).attr('stroke', 'var(--ink)').attr('stroke-width', 2);
    g.append('text').attr('x', p[0] + 14).attr('y', p[1] + 4).attr('fill', 'var(--ink)').attr('font-size', 14).attr('font-weight', 600).text(d.name);
  }
  // neighbouring dot entities, for orientation
  g.selectAll('circle.nb').data(DXCC.filter(x => !x.del && !x.shape && x.n !== d.n && x.lat != null)).join('circle').attr('class', 'nb')
    .attr('cx', x => proj([x.lon, x.lat])[0]).attr('cy', x => proj([x.lon, x.lat])[1]).attr('r', 3).attr('fill', 'var(--line-2)');
  zoomable(svg, g, W, H);
}

// ---------------------------------------------------------------- PACK view
function packTotals(p) {
  $('totals').innerHTML = p.def.awards.map(a => {
    const list = p.ents.filter(e => e.t === a.id); let cur = 0, w = 0, c = 0, dw = 0;
    const saveS = S.status; S.status = 'w';
    for (const e of list) { const q = best(p, e); if (e.x) { if (q) dw++; continue; } cur++; if (q) { w++; if (isConf(q)) c++; } }
    S.status = saveS;
    return `<div class="tot" title="${esc(a.desc || '')}"><span class="k">${esc(a.name)} &middot; ${S.band === 'all' ? 'all bands' : bandLabel(S.band)}</span><span class="v">${w}<small> / ${fmt(cur)} worked</small></span><span class="d">${c} confirmed${dw ? ` &middot; +${dw} deleted` : ''}</span></div>`;
  }).join('');
}
async function renderPack() {
  let p;
  try { p = await loadPack(S.pack); } catch (e) {
    $('totals').innerHTML = ''; tabs(null);
    if (e.message === 'list-missing') {
      $('view').innerHTML = `<div class="card empty"><h2>${esc(e.def.name)} &ndash; ${esc(e.def.title)}</h2><p>The award list has not been downloaded yet. DX Award Map downloads it from the official source (<a href="${esc(e.def.list.page)}" target="_blank" rel="noopener">${esc(e.def.list.page)}</a>).</p><button class="btn primary" id="dlnow">Download now</button> <span class="note" id="dlmsg"></span></div>`;
      $('dlnow').onclick = () => updateLists(e.def.id, $('dlmsg'), () => renderPack());
    } else $('view').innerHTML = `<div class="card empty err">Could not load award pack ${esc(S.pack)}: ${esc(e.message)}</div>`;
    return;
  }
  if (S.award !== 'ALL' && !p.def.awards.find(a => a.id === S.award)) S.award = 'ALL';
  filters();
  const pr = processPack(p);
  packTotals(p);
  const needed = p.ents.filter(e => !e.x && inAward(e) && !best(p, e)).length;
  tabs([['map', p.def.map ? 'Map' : 'Overview'], p.def.map ? ['bands', 'By band'] : null, ['needed', 'Still needed', needed], ['suspect', 'Suspect QSOs', pr.sus.length], ['missing', 'Missing codes', pr.missing.length], ['about', 'About']].filter(Boolean));
  const v = $('view');
  if (S.tab === 'needed') return packNeeded(p, v);
  if (S.tab === 'suspect') return packSuspect(p, v);
  if (S.tab === 'missing') return packMissing(p, v);
  if (S.tab === 'bands' && p.def.map) return packBands(p, v);
  if (S.tab === 'about') return packAbout(p, v);
  v.innerHTML = `<section class="split"><div class="card mapcard" id="pleft"></div><div class="card panel" id="ppanel"></div></section>`;
  if (p.def.map) drawPackMap(p, $('pleft')); else regionList(p, $('pleft'));
  packPanel(p);
}
function regionsOf(p) { return p.def.regions.map(([id, name]) => ({ id, name, list: p.ents.filter(e => e.r === id) })); }
function regionList(p, el) {
  const rows = regionsOf(p).map(r => ({ ...r, s: stats(p, r.list) })).filter(r => r.s.cur || r.s.delGot);
  el.innerHTML = `<div class="phead" style="padding:4px 4px 8px"><h2>${esc(p.def.regionLabel)}s</h2><span class="note">Click one to see its ${esc(p.def.awards[0].label)}</span></div>
    <div class="tscroll"><table><thead><tr><th>${esc(p.def.regionLabel)}</th><th>Progress</th><th class="num">Got</th><th class="num">Of</th></tr></thead><tbody>
    ${rows.map(r => `<tr class="click${S.region === r.id ? ' sel' : ''}" data-r="${esc(r.id)}"><td><span class="mono">${esc(r.id)}</span> ${esc(r.name)}${r.s.cur && r.s.got === r.s.cur ? ' <span style="color:var(--gold)">&#10003;</span>' : ''}</td><td><span class="bar"><i style="width:${pct(r.s.got, r.s.cur)}%"></i></span>${pct(r.s.got, r.s.cur)}%</td><td class="num">${r.s.got}</td><td class="num">${r.s.cur}</td></tr>`).join('')}
    </tbody></table></div>`;
  el.querySelectorAll('tr[data-r]').forEach(tr => tr.onclick = () => { S.region = S.region === tr.dataset.r ? null : tr.dataset.r; S.q = ''; renderPack(); });
}
function packFeatures(p, spec, data) {
  let feats;
  if (spec.format === 'topojson') feats = topojson.feature(data, data.objects[spec.object]).features;
  else feats = data.features.map(rewind);
  for (const f of feats) { const raw = String(f[spec.joinProp] ?? f.properties?.[spec.joinProp] ?? ''); f.region = spec.joinMap ? spec.joinMap[raw] : raw; }
  return feats.filter(f => f.region);
}
function drawPackMap(p, el, opts = {}) {
  const W = opts.w || 640, H = opts.h || 600, small = !!opts.small, band = opts.band ?? S.band;
  const spec = p.def.map;
  if (!p.features) p.features = packFeatures(p, spec, p.map);
  const feats = p.features;
  const insetIds = new Set(spec.inset ? spec.inset.regions : []);
  const main = feats.filter(f => !insetIds.has(f.region));
  const fitObj = spec.fit ? { type: 'MultiPoint', coordinates: spec.fit } : { type: 'FeatureCollection', features: main };
  const proj = projectionFor(spec.projection, W, H, fitObj);
  const path = d3.geoPath(proj);
  if (!small) el.innerHTML = `<div class="maptools"><button class="btn small" id="preset">Reset zoom</button><span class="note">Scroll to zoom, drag to pan, click a ${esc(p.def.regionLabel.toLowerCase())}</span></div><svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of ${esc(p.def.name)}"></svg><div class="legend">${rampLegend(p.def.awards[0].label)}</div>`;
  else el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"></svg>`;
  const svg = d3.select(el.querySelector('svg'));
  const g = svg.append('g');
  const rs = new Map(regionsOf(p).map(r => [r.id, stats(p, r.list, band)]));
  const fill = f => { const s = rs.get(f.region); return s ? rampFill(s.cur ? s.got / s.cur : 0, s.cur) : 'var(--surface-2)'; };
  const done = f => { const s = rs.get(f.region); return s && s.cur > 0 && s.got === s.cur; };
  const sel = g.selectAll('path').data(main).join('path').attr('class', 'shape' + (small ? '' : ' click')).attr('d', path).attr('fill', fill).classed('done', done).classed('sel', f => !small && f.region === S.region);
  let insetSel = null;
  if (spec.inset) {
    const IB = [[10, 10], [175, 140]];
    svg.append('rect').attr('class', 'inset-box').attr('x', IB[0][0]).attr('y', IB[0][1]).attr('width', IB[1][0] - IB[0][0]).attr('height', IB[1][1] - IB[0][1]).attr('rx', 6);
    if (!small) svg.append('text').attr('class', 'inset-lbl').attr('x', IB[0][0] + 8).attr('y', IB[1][1] - 8).text(spec.inset.label || '');
    const pO = d3.geoMercator().fitExtent([[IB[0][0] + 8, IB[0][1] + 8], [IB[1][0] - 8, IB[1][1] - 20]], { type: 'MultiPoint', coordinates: spec.inset.fit });
    svg.append('clipPath').attr('id', 'iclip' + (small ? band : '')).append('rect').attr('x', IB[0][0]).attr('y', IB[0][1]).attr('width', IB[1][0] - IB[0][0]).attr('height', IB[1][1] - IB[0][1]);
    insetSel = svg.append('g').attr('clip-path', `url(#iclip${small ? band : ''})`).selectAll('path').data(feats.filter(f => insetIds.has(f.region))).join('path').attr('class', 'shape' + (small ? '' : ' click')).attr('d', d3.geoPath(pO)).attr('fill', fill).classed('done', done);
  }
  if (small) return;
  // labels with counts
  const lab = g.selectAll('text').data(d3.groups(main, f => f.region).map(([r, fs]) => { const big = fs.reduce((a, b) => path.area(a) > path.area(b) ? a : b); const b = path.bounds(big); return { r, c: path.centroid(big), w: b[1][0] - b[0][0], h: b[1][1] - b[0][1] }; }))
    .join('text').attr('class', 'plabel').attr('x', d => d.c[0]).attr('y', d => d.c[1]);
  const paintLabels = k => lab.text(d => { const s = rs.get(d.r); return s ? `${s.got}/${s.cur}` : ''; }).attr('font-size', 10 / k).attr('fill', d => { const s = rs.get(d.r); return labelInk(s && s.cur ? s.got / s.cur : 0); }).attr('display', d => (d.w * k > 34 && d.h * k > 14) ? null : 'none');
  paintLabels(1);
  const tipFor = f => { const s = rs.get(f.region); const per = p.def.awards.filter(a => S.award === 'ALL' || S.award === a.id).map(a => { const x = stats(p, p.ents.filter(e => e.r === f.region && e.t === a.id)); return x.cur || x.delGot ? `${esc(a.name)}: <b>${x.got}</b>/${x.cur}${x.delGot ? ` +${x.delGot} deleted` : ''}` : ''; }).filter(Boolean); return `<b>${esc(p.regionName.get(f.region) || f.region)}</b> <span style="opacity:.7">${esc(f.region)}</span><br>${per.join('<br>')}`; };
  const bind = s => s.on('mouseenter', (ev, f) => showTip(ev, tipFor(f))).on('mousemove', moveTip).on('mouseleave', hideTip).on('click', (ev, f) => { S.region = S.region === f.region ? null : f.region; S.q = ''; hideTip(); renderPack(); });
  bind(sel); if (insetSel) bind(insetSel);
  $('preset').onclick = zoomable(svg, g, W, H, paintLabels);
}
function bandCells(p, e) {
  const fl = q => q && ((q._pk?.[p.id] || 0) & SOFT);
  let h = `<td class="b any">${dotHtml(best(p, e, 'all'), fl(best(p, e, 'all')))}</td>`;
  for (const b of BANDS) { const q = best(p, e, b); h += `<td class="b${S.band === b ? ' on' : ''}">${dotHtml(q, fl(q))}</td>`; }
  return h;
}
function entityRows(p, list) {
  const qq = S.q.trim().toLowerCase();
  const shown = list.filter(e => (S.del || !e.x) && inAward(e) && (!qq || e.c.toLowerCase().includes(qq) || e.n.toLowerCase().includes(qq)));
  let body = '';
  for (const a of p.def.awards) {
    const g = shown.filter(e => e.t === a.id).sort((x, y) => x.c.localeCompare(y.c, undefined, { numeric: true })); if (!g.length) continue;
    if (p.def.awards.length > 1) body += `<tr class="grp"><td colspan="${3 + BANDS.length}">${esc(a.name)} &middot; ${esc(a.label)}</td></tr>`;
    body += g.map(e => `<tr class="${e.x ? 'del' : ''}"><td class="mono">${esc(e.t === 'CNTY' ? e.c.split(',')[0] : e.c)}</td><td class="nm"${e.x ? ` data-del="deleted${e.d && e.d !== '1900-01-01' ? ' ' + esc(e.d) : ''}"` : ''}>${esc(e.n)}${e.par ? ` <span class="note">(${esc(p.byKey.get('JCC:' + e.par)?.n || e.par)})</span>` : ''}</td>${bandCells(p, e)}</tr>`).join('');
  }
  return { body, count: shown.length };
}
function packPanel(p) {
  const el = $('ppanel');
  const flat = p.def.flat || (!p.def.map && S.region == null); // no map: the region list is on the left, so show all areas here
  if (!flat && S.region == null) {
    // overview of regions
    const rows = regionsOf(p).map(r => ({ ...r, s: stats(p, r.list) })).filter(r => r.s.cur || r.s.delGot);
    el.innerHTML = `<div class="phead"><h2>All ${esc(p.def.regionLabel.toLowerCase())}s</h2><span class="note">Click a ${esc(p.def.regionLabel.toLowerCase())} to see every ${esc(p.def.awards[0].label.replace(/s$/, ''))} by band</span></div>
      <div class="tscroll"><table><thead><tr><th>${esc(p.def.regionLabel)}</th><th>Progress</th><th class="num">Got</th><th class="num">Current</th><th class="num">Deleted got</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="click" data-r="${esc(r.id)}"><td><span class="mono">${esc(r.id)}</span> ${esc(r.name)}${r.s.cur && r.s.got === r.s.cur ? ' <span style="color:var(--gold)">&#10003;</span>' : ''}</td><td><span class="bar"><i style="width:${pct(r.s.got, r.s.cur)}%"></i></span>${pct(r.s.got, r.s.cur)}%</td><td class="num">${r.s.got}</td><td class="num">${r.s.cur}</td><td class="num">${r.s.delGot || ''}</td></tr>`).join('')}
      </tbody></table></div>`;
    el.querySelectorAll('tr[data-r]').forEach(tr => tr.onclick = () => { S.region = tr.dataset.r; S.q = ''; renderPack(); });
    return;
  }
  const list = flat ? p.ents : p.ents.filter(e => e.r === S.region);
  const { body, count } = entityRows(p, list);
  const title = S.region == null ? `${esc(p.def.name)} &ndash; ${esc(p.def.title)}` : `${esc(p.regionName.get(S.region) || S.region)} <span class="note mono">${esc(S.region)}</span>`;
  const head = p.def.awards.filter(a => S.award === 'ALL' || S.award === a.id).map(a => { const s = stats(p, list.filter(e => e.t === a.id)); return s.cur || s.delGot ? `<span>${esc(a.name)} <b>${s.got}</b>/${s.cur}${s.delGot ? ` &middot; +${s.delGot} deleted` : ''}</span>` : ''; }).join('');
  el.innerHTML = `<div class="phead"><h2>${title}</h2><div class="pstats">${head}</div></div>
    ${p.def.entityMap && !flat ? '<div id="emap" class="card" style="padding:6px"></div>' : ''}
    <div class="toolbar"><input class="search" id="psearch" placeholder="Filter by name or code" value="${esc(S.q)}" aria-label="Filter">
      ${S.region == null ? '' : `<button class="btn small" id="pback">All ${esc(p.def.regionLabel.toLowerCase())}s</button>`}
      <span class="note"><span class="dot c"></span> confirmed &nbsp; <span class="dot w"></span> worked &nbsp; <span class="dot w f"></span> suspect code &nbsp; ${count} shown</span></div>
    <div class="tscroll"><table class="mx"><thead><tr><th>Code</th><th>Name</th><th class="b">Any</th>${BANDS.map(b => `<th class="b${S.band === b ? ' on' : ''}">${b}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${3 + BANDS.length}" class="note">Nothing to show.</td></tr>`}</tbody></table></div>`;
  const ps = $('psearch'); ps.oninput = () => { S.q = ps.value; const pos = ps.selectionStart; packPanel(p); const n = $('psearch'); n.focus(); n.setSelectionRange(pos, pos); };
  if (S.region != null) $('pback').onclick = () => { S.region = null; S.q = ''; renderPack(); };
  if (p.def.entityMap && !flat) drawEntityMap(p, $('emap'), list);
}
function drawEntityMap(p, el, list) {
  const spec = p.def.entityMap;
  if (!p.efeatures) p.efeatures = packFeatures(p, spec, p.entityMap);
  const codes = new Set(list.map(e => e.c));
  const feats = p.efeatures.filter(f => codes.has(f.region)); if (!feats.length) { el.hidden = true; return; }
  const W = 600, H = 300;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="Map of the ${esc(spec.award)} areas"></svg>`;
  const proj = d3.geoMercator().fitExtent([[6, 6], [W - 6, H - 6]], { type: 'FeatureCollection', features: feats });
  const path = d3.geoPath(proj); const svg = d3.select(el.querySelector('svg')); const g = svg.append('g');
  const ent = f => p.byKey.get(spec.award + ':' + f.region);
  g.selectAll('path').data(feats).join('path').attr('class', 'shape').attr('d', path)
    .attr('fill', f => { const q = best(p, ent(f)); return q ? (isConf(q) ? 'var(--accent)' : 'var(--worked)') : 'var(--empty)'; })
    .on('mouseenter', (ev, f) => { const e = ent(f), q = best(p, e); showTip(ev, `<b>${esc(e.n)}</b><br>${q ? qsoTip(q) : 'Not ' + (S.status === 'c' ? 'confirmed' : 'worked')}`); }).on('mousemove', moveTip).on('mouseleave', hideTip);
  zoomable(svg, g, W, H);
}
function packBands(p, v) {
  const items = ['all'].concat(BANDS);
  v.innerHTML = `<div class="mini-grid">${items.map(b => { const s = stats(p, p.ents, b); return `<div class="card mini${S.band === b ? ' on' : ''}" data-b="${b}" tabindex="0" role="button"><div class="mh"><b>${b === 'all' ? 'All bands' : bandLabel(b)}</b><span class="num note">${s.got} / ${s.cur} &middot; ${pct(s.got, s.cur)}%</span></div><div class="mm"></div></div>`; }).join('')}</div>`;
  v.querySelectorAll('.mini').forEach(m => { drawPackMap(p, m.querySelector('.mm'), { w: 320, h: 300, small: true, band: m.dataset.b }); const go = () => { S.band = m.dataset.b; location.hash = p.id; }; m.onclick = go; m.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }; });
}
function bandChips(p, e) { let h = ''; for (const b of BANDS) { const q = best(p, e, b); if (q) h += `<span class="chip${isConf(q) ? ' c' : ''}">${b}</span>`; } return h || '<span class="note">none</span>'; }
function packNeeded(p, v) {
  const rows = p.ents.filter(e => !e.x && inAward(e) && !best(p, e));
  const cols = [{ k: 'c', h: 'Code', v: r => r.c }, { k: 'n', h: 'Name', v: r => r.n }, { k: 't', h: 'Award', v: r => r.t }, { k: 'r', h: p.def.regionLabel, v: r => r.r }];
  const head = sortable('needed-' + p.id, cols, rows, 'c');
  const saveBand = S.band;
  v.innerHTML = `<section class="card tablecard"><div class="phead"><h2>Still needed &middot; ${S.band === 'all' ? 'all bands' : bandLabel(S.band)} &middot; ${S.status === 'c' ? 'not confirmed' : 'not worked'}</h2><span class="note">${fmt(rows.length)} current areas${S.band !== 'all' ? '. Chips show bands where it is already ' + (S.status === 'c' ? 'confirmed' : 'worked') : ''}</span></div>
    <div class="tscroll"><table>${S.band === 'all' ? head : head.replace('</tr></thead>', '<th>Other bands</th></tr></thead>')}<tbody>${rows.slice(0, 5000).map(e => `<tr><td class="mono">${esc(e.c)}</td><td>${esc(e.n)}</td><td>${esc(e.t)}</td><td>${esc(p.regionName.get(e.r) || e.r)}</td>${saveBand === 'all' ? '' : `<td>${bandChips(p, e)}</td>`}</tr>`).join('')}</tbody></table></div></section>`;
  bindSort(v, 'needed-' + p.id, () => packNeeded(p, v));
}
function packSuspect(p, v) {
  const rows = processPack(p).sus.slice();
  const cols = [{ k: 'date', h: 'Date', v: r => r.q.date }, { k: 'call', h: 'Call', v: r => r.q.call }, { k: 'band', h: 'Band', v: r => BAND_ORDER.indexOf(r.q.band) }, { k: 'mode', h: 'Mode', v: r => r.q.mode }, { k: 'code', h: 'Code(s)', v: r => r.codes.join('/') }, { k: 'ent', h: 'Area', v: r => r.ent?.n || '' }, { k: 'why', h: 'Reason', v: r => r.flags }, { k: 'key', h: 'Log record', v: r => +r.q.key, num: true }];
  const head = sortable('sus-' + p.id, cols, rows, 'date', -1);
  v.innerHTML = `<section class="card tablecard"><div class="phead"><h2>Suspect QSOs</h2><span class="note">Codes that may be wrong in your log. Filled reasons never count; outlined ones count unless "Exclude suspect QSOs" is on.</span></div>
    <div class="tscroll"><table>${head}<tbody>${rows.map(r => `<tr><td class="num">${esc(r.q.date)}</td><td class="mono">${esc(r.q.call)}</td><td>${esc(bandLabel(r.q.band))}</td><td>${esc(r.q.mode)}</td><td class="mono">${esc(r.codes.join(' / '))}</td><td>${r.ent ? esc(r.ent.n) + ' <span class="note">' + esc(p.regionName.get(r.ent.r) || '') + '</span>' : '<span class="note">unknown</span>'}</td><td>${Object.keys(FLAGTXT).filter(k => r.flags & k).map(k => `<span class="reason${k & HARD ? ' hard' : ''}">${FLAGTXT[k]}</span>`).join('')}</td><td class="num">${esc(r.q.key)}</td></tr>`).join('')}</tbody></table></div></section>`;
  bindSort(v, 'sus-' + p.id, () => packSuspect(p, v));
}
function packMissing(p, v) {
  const rows = processPack(p).missing.slice();
  const cols = [{ k: 'date', h: 'Date', v: r => r.date }, { k: 'call', h: 'Call', v: r => r.call }, { k: 'band', h: 'Band', v: r => BAND_ORDER.indexOf(r.band) }, { k: 'mode', h: 'Mode', v: r => r.mode }, { k: 'conf', h: 'QSL', v: r => isConf(r) ? 1 : 0 }, { k: 'op', h: 'Operator', v: r => r.op }, { k: 'key', h: 'Log record', v: r => +r.key, num: true }];
  const head = sortable('miss-' + p.id, cols, rows, 'date', -1);
  const srcs = p.def.awards.map(a => sourcesFor(p, a.sources ? a : null) || []).flat().map(s => s.field + (s.with ? '+' + s.with : '')).filter((x, i, arr) => arr.indexOf(x) === i);
  v.innerHTML = `<section class="card tablecard"><div class="phead"><h2>QSOs without a code</h2><span class="note">${fmt(rows.length)} QSOs with ${esc(p.def.name)} (${rows.filter(isConf).length} confirmed) have no code in ${srcs.map(s => `<span class="mono">${esc(s)}</span>`).join(', ') || 'the mapped fields'}. Add the codes in your log, or change the field mapping in <a href="#settings">Settings</a>.</span></div>
    <div class="tscroll"><table>${head}<tbody>${rows.slice(0, 5000).map(r => `<tr><td class="num">${esc(r.date)}</td><td class="mono">${esc(r.call)}</td><td>${esc(bandLabel(r.band))}</td><td>${esc(r.mode)}</td><td>${isConf(r) ? 'Confirmed' : ''}</td><td>${esc(r.op)}</td><td class="num">${esc(r.key)}</td></tr>`).join('')}</tbody></table>${rows.length > 5000 ? '<p class="note">First 5,000 shown.</p>' : ''}</div></section>`;
  bindSort(v, 'miss-' + p.id, () => packMissing(p, v));
}
function packAbout(p, v) {
  const awards = p.def.awards.map(a => { const src = sourcesFor(p, a.sources ? a : null) || []; return `<tr><td><b>${esc(a.name)}</b></td><td>${esc(a.desc || '')}</td><td class="num">${fmt(p.ents.filter(e => e.t === a.id && !e.x).length)}</td><td class="num">${fmt(p.ents.filter(e => e.t === a.id && e.x).length)}</td><td>${src.map(s => `<span class="mono">${esc(s.field)}${s.with ? ' + ' + esc(s.with) : ''}</span>${s.re ? ` <span class="note mono">${esc(s.re)}</span>` : ''}`).join('<br>')}</td></tr>`; }).join('');
  const listInfo = p.meta ? ` List date: <b>${esc(p.meta.listDate || 'unknown')}</b>; downloaded ${esc(p.meta.updated)}. <a href="#settings">Update award lists</a>` : '';
  v.innerHTML = `<section class="card tablecard"><h2>${esc(p.def.name)} &ndash; ${esc(p.def.title)}</h2><p class="note">Source: ${p.def.list ? `<a href="${esc(p.def.list.page)}" target="_blank" rel="noopener">${esc(p.def.source)}</a>` : esc(p.def.source)}. DXCC ${p.def.dxcc.join(', ')}.${listInfo}</p>
    <table><thead><tr><th>Award</th><th>Description</th><th class="num">Current</th><th class="num">Deleted</th><th>Read from (${CFG.source === 'adif' ? 'ADIF' : 'N3FJP'})</th></tr></thead><tbody>${awards}</tbody></table>
    <p class="note">Change which log fields are used in <a href="#settings">Settings &rarr; Field mapping</a>.</p></section>`;
}

// ---------------------------------------------------------------- SETTINGS view
let fieldStats = null, mapPack = null, draft = null;
async function renderSettings() {
  $('totals').innerHTML = ''; tabs(null);
  const v = $('view');
  let status = {}; try { status = await getJSON('/api/status'); } catch (e) { }
  draft = draft || JSON.parse(JSON.stringify(CFG));
  draft.ui = draft.ui || {}; draft.mapping = draft.mapping || {};
  const conf = Object.assign({ L: true, E: true, C: true }, draft.ui.confirm || {});
  const n3 = draft.n3fjpPath || '';
  v.innerHTML = `<div class="settings">
    <section class="card sect"><h2>Log</h2>
      <div class="row"><label><input type="radio" name="src" value="n3fjp" ${draft.source !== 'adif' ? 'checked' : ''}> N3FJP Amateur Contact Log (read live)</label><label><input type="radio" name="src" value="adif" ${draft.source === 'adif' ? 'checked' : ''}> ADIF file from any logger (re-read when it changes)</label></div>
      <div id="src-n3fjp" ${draft.source === 'adif' ? 'hidden' : ''}>
        <div class="row"><label><input type="checkbox" id="n3auto" ${n3 ? '' : 'checked'}> Use N3FJP's active log</label><span class="note">${status.n3fjpActive ? 'Active: <span class="mono">' + esc(status.n3fjpActive) + '</span>' : 'N3FJP settings not found on this PC'}</span></div>
        <div class="row" id="n3pick" ${n3 ? '' : 'hidden'}><span class="path" id="n3path">${esc(n3 || 'No file chosen')}</span><button class="btn" id="n3browse">Choose log file&hellip;</button></div>
      </div>
      <div id="src-adif" ${draft.source === 'adif' ? '' : 'hidden'}><div class="row"><span class="path" id="adpath">${esc(draft.adifPath || 'No file chosen')}</span><button class="btn" id="adbrowse">Choose ADIF file&hellip;</button></div>
        <p class="note">Export your log as ADIF (.adi) from your logging program into a fixed file and choose it here. Export again to update the map; DX Award Map notices the new file within seconds.</p></div>
      <div class="statusline">${status.status === 'ok' ? `<span class="live">Reading</span> <span class="mono">${esc(status.file)}</span>: ${fmt(status.count)} QSOs${status.engine ? ' <span class="note">(' + esc(status.engine) + ')</span>' : ''}` : status.status === 'error' ? `<span class="err">${esc(status.error)}</span>` : 'Reading&hellip;'}</div>
    </section>
    <section class="card sect"><h2>What counts</h2>
      <div class="row"><span>Confirmations that count:</span><label><input type="checkbox" id="cL" ${conf.L ? 'checked' : ''}> LoTW</label><label><input type="checkbox" id="cE" ${conf.E ? 'checked' : ''}> eQSL</label><label><input type="checkbox" id="cC" ${conf.C ? 'checked' : ''}> Paper card</label></div>
      <div class="row"><label><input type="checkbox" id="vhf" ${draft.ui.vhf ? 'checked' : ''}> Show VHF/UHF bands (2 m, 70 cm, ...)</label></div>
    </section>
    <section class="card sect"><h2>Program</h2>
      <div class="row"><label><input type="checkbox" id="sww" ${draft.startWithWindows ? 'checked' : ''}> Start with Windows (in the system tray)</label><label>Port <input type="number" id="port" min="1025" max="65000" value="${esc(draft.port || 8766)}" style="width:90px"></label><span class="note">DX Award Map ${esc(status.app || '')} &middot; <a href="${esc(status.project || '#')}" target="_blank" rel="noopener">project page, updates and questions</a></span></div>
    </section>
    <section class="card sect"><h2>Award lists</h2>
      <p class="note">These lists are downloaded from their official sources and refreshed automatically when they are more than 30 days old.</p>
      <div id="listbox" class="note">Loading&hellip;</div>
      <div class="row"><button class="btn" id="listall">Update all award lists now</button><span class="note" id="listmsg"></span></div>
    </section>
    <section class="card sect"><h2>Field mapping</h2>
      <p class="note">Which field of your log holds each award's code. The defaults follow common habits (for example RDA in N3FJP's Other2); change them if you log codes elsewhere. A pattern (regular expression) picks the code out of a longer text; its first group in brackets is used.</p>
      <div class="row"><label>Award pack <select id="mpack">${PACKS.map(p => `<option value="${p.id}" ${mapPack === p.id ? 'selected' : ''}>${esc(p.name)} &ndash; ${esc(p.title)}</option>`).join('')}</select></label><button class="btn small" id="mreset">Reset this pack to defaults</button></div>
      <div id="mapbox"></div>
      <h3>Fields in your log for this country</h3><div id="fieldbox" class="note">Loading&hellip;</div>
    </section>
    <div class="savebar"><button class="btn primary" id="save">Save settings</button><span class="note" id="savemsg"></span></div>
  </div>`;
  v.querySelectorAll('input[name=src]').forEach(r => r.onchange = () => { draft.source = r.value; $('src-n3fjp').hidden = r.value === 'adif'; $('src-adif').hidden = r.value !== 'adif'; mappingEditor(); });
  $('n3auto').onchange = e => { $('n3pick').hidden = e.target.checked; if (e.target.checked) draft.n3fjpPath = ''; };
  $('n3browse').onclick = async () => { const r = await getJSON('/api/pick?kind=mdb'); if (r.path) { draft.n3fjpPath = r.path; $('n3path').textContent = r.path; } };
  $('adbrowse').onclick = async () => { const r = await getJSON('/api/pick?kind=adif'); if (r.path) { draft.adifPath = r.path; $('adpath').textContent = r.path; } };
  if (!mapPack) mapPack = (PACKS.map(p => [p.id, Q.filter(q => p.dxcc.includes(q.dxcc)).length]).sort((a, b) => b[1] - a[1])[0] || [PACKS[0]?.id])[0];
  $('mpack').value = mapPack;
  $('mpack').onchange = e => { mapPack = e.target.value; mappingEditor(); };
  $('mreset').onclick = () => { for (const k of Object.keys(draft.mapping)) if (k.startsWith(mapPack + '/')) delete draft.mapping[k]; mappingEditor(); };
  $('save').onclick = saveSettings;
  $('listall').onclick = () => updateLists('', $('listmsg'), listsBox);
  listsBox();
  mappingEditor();
}
async function listsBox() {
  const box = $('listbox'); if (!box) return;
  let st = []; try { st = await getJSON('/api/lists'); } catch (e) { box.textContent = 'Could not read the list status.'; return; }
  box.innerHTML = `<table><thead><tr><th>Award</th><th>List date</th><th>Downloaded</th><th class="num">Entries</th><th>Status</th><th></th></tr></thead><tbody>${st.map(l => `<tr><td><b>${esc(l.name)}</b> &ndash; ${esc(l.title)}</td><td>${esc(l.meta?.listDate || '')}</td><td>${esc(l.meta?.updated || (l.have ? 'shipped with the program' : ''))}</td><td class="num">${l.count ? fmt(l.count) : ''}</td><td>${l.busy ? 'Downloading&hellip;' : l.error ? `<span class="err">${esc(l.error)}</span>` : l.have ? 'OK' : '<span class="err">Not downloaded</span>'}</td><td><button class="btn small" data-upd="${esc(l.id)}">Update</button> <a class="note" href="${esc(l.page)}" target="_blank" rel="noopener">source</a></td></tr>`).join('')}</tbody></table>`;
  box.querySelectorAll('[data-upd]').forEach(b => b.onclick = () => updateLists(b.dataset.upd, $('listmsg'), listsBox));
  if (st.some(l => l.busy)) setTimeout(listsBox, 1500);
}
// ask the program to download one list (id) or all (''), then wait until it is done
async function updateLists(id, msgEl, done) {
  if (msgEl) msgEl.textContent = 'Downloading...';
  try {
    await fetch('/api/lists/update' + (id ? '?id=' + encodeURIComponent(id) : ''), { method: 'POST' });
    await new Promise(r => setTimeout(r, 800));
    for (let i = 0; i < 120; i++) {
      const st = await getJSON('/api/lists');
      const mine = st.filter(l => !id || l.id === id);
      if (!mine.some(l => l.busy)) {
        const err = mine.find(l => l.error);
        if (msgEl) msgEl.textContent = err ? 'Problem: ' + err.error : 'Done.';
        for (const l of mine) packCache.delete(l.id);
        done && done(); return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) { if (msgEl) msgEl.textContent = 'Could not download: ' + e.message; }
}
async function mappingEditor() {
  const p = await loadPack(mapPack);
  const groups = [];
  if (p.def.codeSources) groups.push({ key: p.id + '/*', label: p.def.awards.filter(a => !a.sources).map(a => a.name).join(' / '), def: p.def.codeSources[draft.source] || [] });
  for (const a of p.def.awards.filter(a => a.sources)) groups.push({ key: p.id + '/' + a.id, label: a.name, def: a.sources[draft.source] || [] });
  fieldStats = null;
  const fieldsP = getJSON('/api/fields?dxcc=' + p.def.dxcc.join(',')).catch(() => []);
  const render = list => {
    const opts = (cur) => `<option value="">(none)</option>` + [...new Set(list.map(f => f.field).concat(cur ? [cur] : []))].map(f => { const st = list.find(x => x.field === f); return `<option value="${esc(f)}" ${f === cur ? 'selected' : ''}>${esc(f)}${st && st.title ? ' (' + esc(st.title) + ')' : ''}${st ? ' &ndash; ' + pct(st.filled, st.total) + '%' : ''}</option>`; }).join('');
    $('mapbox').innerHTML = groups.map((g, gi) => {
      const cur = draft.mapping[g.key] || g.def;
      return `<table class="maptable" style="margin-top:8px"><thead><tr><th colspan="4">${esc(g.label)} ${draft.mapping[g.key] ? '<span class="badge">changed</span>' : '<span class="badge">default</span>'}</th></tr><tr><th>Field</th><th>Pattern (optional)</th><th>Combined with</th><th></th></tr></thead><tbody>
        ${cur.map((s, si) => `<tr><td><select data-g="${gi}" data-s="${si}" data-k="field">${opts(s.field)}</select></td><td><input type="text" data-g="${gi}" data-s="${si}" data-k="re" value="${esc(s.re || '')}" placeholder="whole value"></td><td><select data-g="${gi}" data-s="${si}" data-k="with">${opts(s.with || '')}</select></td><td><button class="btn small" data-del="${gi}:${si}">Remove</button></td></tr>`).join('')}
        <tr><td colspan="4"><button class="btn small" data-add="${gi}">Add a field</button></td></tr></tbody></table>`;
    }).join('');
    const edit = gi => { const g = groups[gi]; if (!draft.mapping[g.key]) draft.mapping[g.key] = JSON.parse(JSON.stringify(g.def)); return draft.mapping[g.key]; };
    $('mapbox').querySelectorAll('[data-k]').forEach(el => el.onchange = () => { const m = edit(+el.dataset.g); const s = m[+el.dataset.s]; const v = el.value; if (v) s[el.dataset.k] = v; else delete s[el.dataset.k]; render(list); });
    $('mapbox').querySelectorAll('[data-add]').forEach(b => b.onclick = () => { edit(+b.dataset.add).push({ field: '' }); render(list); });
    $('mapbox').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const [gi, si] = b.dataset.del.split(':').map(Number); edit(gi).splice(si, 1); render(list); });
    $('fieldbox').innerHTML = list.length ? `<div class="fieldlist">${list.filter(f => f.filled).sort((a, b) => b.filled - a.filled).map(f => `<div><b>${esc(f.field)}</b>${f.title ? ' (' + esc(f.title) + ')' : ''}: ${pct(f.filled, f.total)}% filled &middot; <span class="mono">${f.samples.slice(0, 4).map(esc).join(', ')}</span></div>`).join('')}</div>` : 'No QSOs with this country in your log, or the log could not be read.';
  };
  render([]);
  render(await fieldsP);
}
async function saveSettings() {
  draft.ui.confirm = { L: $('cL').checked, E: $('cE').checked, C: $('cC').checked };
  draft.ui.vhf = $('vhf').checked;
  draft.startWithWindows = $('sww').checked;
  draft.port = +$('port').value || 8766;
  for (const [k, list] of Object.entries(draft.mapping)) draft.mapping[k] = list.filter(s => s.field);
  try {
    CFG = await getJSON('/api/settings', { method: 'POST', body: JSON.stringify(draft), headers: { 'Content-Type': 'application/json' } });
    draft = null; $('savemsg').textContent = 'Saved. Reading the log again...';
    for (const p of packCache.values()) p.processed = null; worldCache = null;
    setTimeout(async () => { try { await fetchData(); } catch (e) { } render(); }, 2500);
  } catch (e) { $('savemsg').textContent = 'Could not save: ' + e.message; }
}

// ---------------------------------------------------------------- routing & render
function route() {
  const h = decodeURIComponent(location.hash.slice(1)) || 'world';
  const [page, tab] = h.split('--');
  if (page === 'settings') { S.view = 'settings'; }
  else if (page === 'world') { S.view = 'world'; S.tab = tab || 'map'; }
  else if (/^dx-\d+$/.test(page)) { const n = +page.slice(3); if (S.dx !== n) S.q = ''; S.view = 'dx'; S.dx = n; S.tab = tab || 'map'; }
  else if (PACKBY.has(page)) { if (S.pack !== page) { S.region = null; S.award = 'ALL'; S.q = ''; } S.view = 'pack'; S.pack = page; S.tab = tab || 'map'; }
  else { S.view = 'world'; S.tab = 'map'; }
  if (S.view !== 'settings') draft = null;
  render();
}
window.addEventListener('hashchange', route);
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq; hideTip();
  header(); filters();
  if (S.view === 'settings') return renderSettings();
  if (S.view === 'world') return renderWorld();
  if (S.view === 'dx') return renderDx();
  if (S.view === 'pack') { await renderPack(); if (seq !== renderSeq) return; }
}
document.addEventListener('keydown', ev => {
  if (ev.target.matches('input, select, textarea')) return;
  if (ev.key === 'Escape') { S.region = null; S.sel = null; render(); }
});

// ---------------------------------------------------------------- boot + live updates
async function boot() {
  try { CFG = await getJSON('/api/settings'); } catch (e) { }
  S.op = uiPref('op', 'ALL');
  const [dx, world, idx] = await Promise.all([getJSON('/data/dxcc.json'), getJSON('/data/world.json'), getJSON('/packs/index.json')]);
  DXCC = dx.dxcc.map(([n, name, pfx, cont, lat, lon, del, shape]) => ({ n, name, pfx, cont, lat, lon, del: !!del, shape: !!shape }));
  DXBY = new Map(DXCC.map(d => [d.n, d]));
  world.features.forEach(rewind);
  WORLD = world; PACKS = idx.packs.filter(p => p.areas >= 3); PACKBY = new Map(PACKS.map(p => [p.id, p]));
  try { await fetchData(); LIVE = 'ok'; } catch (e) { LIVE = 'off'; }
  if (!CFG.configured && !location.hash) location.hash = 'settings';
  route();
  setInterval(async () => {
    try {
      const v = await (await fetch('/api/version', { cache: 'no-store' })).text();
      const changed = v !== META.version;
      if (changed) await fetchData();
      if (changed || LIVE !== 'ok') { LIVE = 'ok'; if (S.view !== 'settings') render(); else header(); }
    } catch (e) { if (LIVE !== 'off') { LIVE = 'off'; header(); } }
  }, 5000);
}
boot();
