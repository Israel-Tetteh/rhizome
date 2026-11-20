import {
  settings, usage, getWork, getWorksByIds, getWorksByDois, getAuthor, getAuthorWorks, searchWorks,
  resolveViaSemanticScholar, abstractFrom, authorNames, authorList, shortLabel, venue, doiUrl, ApiError,
} from './openalex.js?v=20261120e';
import { buildGraph, assembleGraph, priorWorks, derivativeWorks } from './graph-builder.js?v=20261120e';
import { createGraphView, topicOf, MAP_METRICS } from './graph-view.js?v=20261120e';
import { toBibTeX, toRIS, toCSV, download } from './export.js?v=20261120e';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '');
const bareDoi = (w) => (w.doi ? w.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : '');

// ---- persisted preferences (this browser only; everything works without them) ----
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('rhizome:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rhizome:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
settings.apiKey = store.get('apiKey', '');
const prefs = {
  size: store.get('size', 40),
  theme: store.get('theme', 'system'),
  colorMode: store.get('colorMode', 'year'),
  layout: store.get('layout', 'similarity'),
  labels: store.get('labels', true),
  hideLeft: store.get('hideLeft', false),
  hideRight: store.get('hideRight', false),
  legendOpen: store.get('legendOpen', true),
  mapX: store.get('mapX', 'year'),
  mapY: store.get('mapY', 'citations'),
};
const MAX_ORIGINS = 25;
const setPref = (k, v) => { prefs[k] = v; store.set(k, v); };

// Saved papers: kept as slim records so they survive across graphs and visits.
const slim = (w) => ({
  id: w.id, title: w.title, doi: w.doi, type: w.type, publication_year: w.publication_year,
  cited_by_count: w.cited_by_count, biblio: w.biblio, open_access: w.open_access, primary_topic: w.primary_topic,
  primary_location: { source: { display_name: venue(w) } },
  authorships: authorNames(w).map((n) => ({ author: { display_name: n } })),
  referenced_works: [],
});
const saved = new Map(store.get('saved', []).map((w) => [w.id, w]));
const persistSaved = () => store.set('saved', [...saved.values()]);
const isSaved = (id) => saved.has(id);
function toggleSaved(w) {
  if (!w) return;
  if (saved.has(w.id)) { saved.delete(w.id); toast('Removed from saved'); }
  else { saved.set(w.id, slim(w)); toast('Saved. Find it in the ★ Saved tab'); }
  persistSaved();
  renderList();
  renderDetail();
}

// ---- state ----
const state = {
  origin: null, origins: [], key: '', graph: null, exclude: new Set(),
  filters: { from: null, to: null, oa: false },
  trail: (() => { try { return JSON.parse(sessionStorage.getItem('rhizome:trail')) || []; } catch { return []; } })(),
  lists: { graph: [], prior: null, derivative: null },
  tab: 'graph', sort: 'sim', filter: '', selected: null, runId: 0, topicFocus: null,
};

const view = createGraphView($('#graph'), {
  onSelect: (id) => selectPaper(id, { fromGraph: true }),
  onOpen: (id) => go(id),
});

// ---- themes ----
const THEMES = [
  { id: 'system', name: 'System', note: 'Follows your device', sw: ['#f3f5f0', '#101512', '#2f6f5e'] },
  { id: 'light', name: 'Meadow', note: 'Light', sw: ['#f3f5f0', '#2f6f5e', '#c9822b'] },
  { id: 'dark', name: 'Night', note: 'Dark', sw: ['#101512', '#7cc3a8', '#e3a04f'] },
  { id: 'sepia', name: 'Paper', note: 'Warm, for long reading', sw: ['#f2eadb', '#7a4b25', '#b5532a'] },
  { id: 'ocean', name: 'Ocean', note: 'Deep blue dark', sw: ['#0b1724', '#5cc8e0', '#f6b26b'] },
  { id: 'contrast', name: 'High contrast', note: 'Maximum legibility', sw: ['#ffffff', '#000000', '#0038a8'] },
];
function applyTheme(id) {
  setPref('theme', id);
  if (id === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  $('meta[name="theme-color"]').setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--surface').trim());
  renderThemeMenu();
  refreshColours();
}
function renderThemeMenu() {
  $('#theme-menu').innerHTML = '<div class="menu-title">Colour theme</div>' + THEMES.map((t) => `
    <button role="menuitemradio" aria-checked="${prefs.theme === t.id}" data-theme-id="${t.id}">
      <span class="sw">${t.sw.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
      <span><b>${t.name}</b><br><small style="color:var(--muted)">${t.note}</small></span>
    </button>`).join('');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (prefs.theme === 'system') refreshColours(); });

function refreshColours() {
  if (!state.graph) return;
  view.recolor();
  renderLegend();
  renderList();
  renderDetail();
}

// ---- menus ----
function wireMenu(btn, menu) {
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    $$('.menu').forEach((m) => { m.hidden = true; });
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('button')?.focus();
  });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
  return close;
}
const closeThemeMenu = wireMenu($('#theme-btn'), $('#theme-menu'));
$('#theme-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-id]');
  if (b) { applyTheme(b.dataset.themeId); closeThemeMenu(); }
});
const closeDownloadMenu = wireMenu($('#download-btn'), $('#download-menu'));
$('#download-menu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-dl]');
  if (!b || !state.graph) return;
  closeDownloadMenu();
  const base = `rhizome-${state.origin.id}`;
  if (b.dataset.dl === 'svg') download(`${base}.svg`, view.exportSVG(), 'image/svg+xml');
  if (b.dataset.dl === 'png') {
    try { const blob = await view.exportPNG(2); downloadBlob(`${base}.png`, blob); } catch (err) { toast(err.message); }
  }
  if (b.dataset.dl === 'all-bib') {
    const all = new Map();
    for (const l of [state.lists.graph, state.lists.prior, state.lists.derivative]) if (Array.isArray(l)) l.forEach((w) => all.set(w.id, w));
    download(`${base}-all.bib`, toBibTeX([...all.values()]), 'application/x-bibtex');
  }
});
function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---- input parsing ----
function parseInput(raw) {
  const s = raw.trim();
  let m;
  if ((m = s.match(/(10\.\d{4,9}\/[^\s"<>]+)/))) return { kind: 'doi', value: m[1].replace(/[.,;]+$/, '') };
  if ((m = s.match(/(?:openalex\.org\/(?:works\/)?|^|#\/)(W\d{4,})\b/i))) return { kind: 'openalex', value: m[1].toUpperCase() };
  if ((m = s.match(/\b([0-9a-f]{40})\b/i))) {
    // Links that carry the title in the path (e.g. …/<id>/Paper-Title-Words/graph) give a fallback search
    const slug = s.match(/[0-9a-f]{40}\/([^/?#]+)/i)?.[1];
    const title = slug && slug !== 'graph' ? decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\.$/, '').trim() : null;
    return { kind: 's2', value: m[1], title };
  }
  if ((m = s.match(/arxiv(?:\.org\/abs\/|:)\s*([\w.\/-]+?)(?:v\d+)?$/i))) return { kind: 's2', value: `arXiv:${m[1]}` };
  if ((m = s.match(/^pmid:?\s*(\d+)$/i))) return { kind: 'pmid', value: m[1] };
  return { kind: 'title', value: s };
}

async function resolve(raw) {
  const p = parseInput(raw);
  if (p.kind === 'doi') return getWork(`doi:${p.value}`);
  if (p.kind === 'openalex') return getWork(p.value);
  if (p.kind === 'pmid') return getWork(`pmid:${p.value}`);
  if (p.kind === 's2') {
    let r;
    try { r = await resolveViaSemanticScholar(p.value); }
    catch (e) { if (p.title) return { needsPick: true, query: p.title }; throw e; }
    if (r.doi) return getWork(`doi:${r.doi}`);
    if (r.title) return { needsPick: true, query: r.title };
    throw new ApiError(404, 'Could not match that Semantic Scholar paper.');
  }
  return { needsPick: true, query: p.value };
}

// ---- routing: #/W123 makes graphs shareable ----
// Several origins are joined with commas: #/W1,W2,W3
function go(id) { location.hash = `#/${Array.isArray(id) ? id.join(',') : id}`; }
window.addEventListener('hashchange', route);
async function route() {
  const m = location.hash.match(/^#\/(W\d+(?:,W\d+)*)/i);
  if (!m) return showLanding();
  const key = [...new Set(m[1].toUpperCase().split(','))].slice(0, MAX_ORIGINS).join(',');
  if (state.graph && state.key === key) return;
  await loadGraph(key);
}
const originLabel = (origins) => (origins.length === 1 ? stripTags(origins[0].title)
  : `${origins.length} papers: ${origins.slice(0, 3).map((o) => shortLabel(o)).join('; ')}${origins.length > 3 ? '…' : ''}`);

function showLanding() {
  $('#landing').hidden = false; $('#workspace').hidden = true;
  document.title = 'Rhizome · paper graphs';
  renderRecent();
}

// ---- recent graphs ----
function remember(origins) {
  const key = origins.map((o) => o.id).join(',');
  const o = origins[0];
  const list = store.get('recent', []).filter((r) => r.id !== key);
  list.unshift(origins.length === 1
    ? { id: key, title: stripTags(o.title), label: shortLabel(o), venue: venue(o), at: Date.now() }
    : { id: key, title: `${origins.length} papers, starting with “${stripTags(o.title).slice(0, 70)}”`, label: origins.slice(0, 3).map(shortLabel).join('; '), venue: '', at: Date.now() });
  store.set('recent', list.slice(0, 9));
}

// ---- trail: the graphs visited this session, to hop back (kept per tab) ----
function pushTrail(origins) {
  const key = origins.map((o) => o.id).join(',');
  const label = origins.length === 1 ? shortLabel(origins[0]) : `${shortLabel(origins[0])} +${origins.length - 1}`;
  const at = state.trail.findIndex((t) => t.key === key);
  if (at >= 0) state.trail = state.trail.slice(0, at + 1);
  else state.trail.push({ key, label, title: originLabel(origins) });
  state.trail = state.trail.slice(-12);
  try { sessionStorage.setItem('rhizome:trail', JSON.stringify(state.trail)); } catch { /* ignore */ }
  renderTrail();
}
function renderTrail() {
  const el = $('#trail');
  el.hidden = state.trail.length < 2;
  el.innerHTML = state.trail.map((t, i) => (t.key === state.key
    ? `<span class="here" aria-current="page" title="${esc(t.title)}">${esc(t.label)}</span>`
    : `<a href="#/${esc(t.key)}" title="${esc(t.title)}">${esc(t.label)}</a>`) + (i < state.trail.length - 1 ? '<i aria-hidden="true">›</i>' : '')).join('');
  el.scrollLeft = el.scrollWidth;
}
function renderRecent() {
  const list = store.get('recent', []);
  $('#recent').hidden = !list.length;
  $('#recent-grid').innerHTML = list.map((r) => `
    <button class="recent-card" data-id="${esc(r.id)}">
      <span class="t">${esc(r.title)}</span>
      <span class="m">${esc(r.label)}${r.venue ? ' · ' + esc(r.venue) : ''}</span>
    </button>`).join('');
}
$('#recent-grid').addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) go(b.dataset.id); });

// ---- search form ----
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); startFrom($('#search-input').value); });
$$('.chip').forEach((c) => c.addEventListener('click', () => { $('#search-input').value = c.dataset.q; startFrom(c.dataset.q); }));
$('#home-link').addEventListener('click', (e) => { e.preventDefault(); history.pushState('', '', location.pathname); showLanding(); });

async function startFrom(raw) {
  if (!raw.trim()) return;
  const box = $('#search-results');
  showLanding();
  box.hidden = false;
  box.innerHTML = '<p class="m">Looking up the paper…</p>';
  try {
    const r = await resolve(raw);
    if (r.needsPick) {
      const hits = await searchWorks(r.query);
      if (!hits.length) { box.innerHTML = `<p class="error">No papers matched “${esc(r.query)}”. Try the DOI instead.</p>`; return; }
      box.innerHTML = `<h2>Pick the paper to start from</h2>` + hits.map((w) => `
        <button class="result" data-id="${w.id}">
          <div class="t">${esc(stripTags(w.title))}</div>
          <div class="m">${esc(authorNames(w).slice(0, 3).join(', '))}${authorNames(w).length > 3 ? ' et al.' : ''} · ${w.publication_year ?? ''} · ${esc(venue(w))} · ${w.cited_by_count ?? 0} citations</div>
        </button>`).join('');
      box.querySelectorAll('.result').forEach((b) => b.addEventListener('click', () => go(b.dataset.id)));
      box.querySelector('.result')?.focus();
    } else {
      box.hidden = true;
      state.origin = r; // reuse fetched record
      go(r.id);
    }
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---- building ----
let steps = [];
function setStatus(text) {
  $('#status').hidden = !text;
  if (text && $('#status-text').textContent && $('#status-text').textContent !== text) steps.push($('#status-text').textContent.replace(/…$/, ''));
  if (!text) steps = [];
  $('#status-text').textContent = text || '';
  $('#status-steps').innerHTML = steps.map((s) => `<li>${esc(s)}</li>`).join('');
}

async function loadGraph(key) {
  const run = ++state.runId;
  const ids = key.split(',');
  $('#landing').hidden = true; $('#workspace').hidden = false;
  steps = []; $('#status-text').textContent = '';
  setStatus(ids.length > 1 ? `Fetching ${ids.length} papers…` : 'Fetching the paper…');
  state.lists = { graph: [], prior: null, derivative: null };
  state.selected = null; state.graph = null; state.topicFocus = null;
  if (state.key !== key) state.exclude = new Set();
  state.key = key;
  $('#filter-input').value = ''; state.filter = '';
  renderList(); renderDetail();
  try {
    let origins;
    if (ids.length === 1) {
      origins = [state.origin?.id === ids[0] && state.origin.referenced_works ? state.origin : await getWork(ids[0])];
    } else {
      const got = new Map((await getWorksByIds(ids)).map((w) => [w.id, w]));
      origins = ids.map((id) => got.get(id)).filter(Boolean);
      if (!origins.length) throw new ApiError(404, 'None of these papers were found in OpenAlex.');
    }
    if (run !== state.runId) return;
    state.origins = origins;
    state.origin = origins[0];
    document.title = `${originLabel(origins).slice(0, 60)} · Rhizome`;
    renderOrigin();
    $('#search-input').value = origins.length === 1 ? (bareDoi(origins[0]) || origins[0].id) : '';
    const graph = await buildGraph(origins, { size: prefs.size, exclude: state.exclude, onProgress: (t) => run === state.runId && setStatus(t) });
    if (run !== state.runId) return;
    if (graph.nodes.length < 2) {
      setStatus('');
      const o = origins[0];
      $('#detail').innerHTML = `<p class="error">OpenAlex has too little citation data for this paper to build a graph (it lists ${o.referenced_works.length} references and ${o.cited_by_count ?? 0} citations). Try a related paper instead.</p>`;
      return;
    }
    remember(origins);
    pushTrail(origins);
    showGraph(graph, run);
    selectPaper(origins.length === 1 ? origins[0].id : null, { fromGraph: true }); // show its details without dimming the graph
  } catch (err) {
    if (run !== state.runId) return;
    setStatus('');
    $('#detail').innerHTML = `<p class="error">${esc(err.message)}</p><p><a href="./" id="back">Back to search</a></p>`;
    $('#back').addEventListener('click', (e) => { e.preventDefault(); history.pushState('', '', location.pathname); showLanding(); });
  }
}

/** Draw a built graph and (re)compute the prior and derivative lists. */
function showGraph(graph, run = state.runId) {
  state.graph = graph;
  state.lists = { graph: graph.nodes, prior: null, derivative: null };
  view.setColorMode(prefs.colorMode);
  view.setLabels(prefs.labels);
  view.setMapAxes({ x: prefs.mapX, y: prefs.mapY });
  try {
    view.render(graph);
    if (prefs.layout !== 'similarity') view.setLayout(prefs.layout);
  } catch (err) {
    console.error('Rhizome: drawing the graph failed', err);
    toast('The graph could not be drawn. Press F to retry, or reload the page.');
  }
  renderLegend();
  setStatus('');
  renderList();
  applyFilters();
  priorWorks(graph).then((l) => { if (run === state.runId) { state.lists.prior = l; renderList(); } })
    .catch((e) => { if (run === state.runId) { state.lists.prior = { error: e.message }; renderList(); } });
  derivativeWorks(graph).then((l) => { if (run === state.runId) { state.lists.derivative = l; renderList(); } })
    .catch((e) => { if (run === state.runId) { state.lists.derivative = { error: e.message }; renderList(); } });
}

// ---- hiding papers: rebuilt locally from the papers already collected (no new searches) ----
function rebuildLocal() {
  if (!state.graph) return;
  const run = ++state.runId;
  const keepSel = state.selected;
  showGraph(assembleGraph(state.graph.origins, state.graph.pool, { size: prefs.size, exclude: state.exclude }), run);
  renderHidden();
  selectPaper(keepSel && state.lists.graph.some((n) => n.id === keepSel) ? keepSel : null);
}
function hidePaper(id) {
  if (!state.graph || state.origins.some((o) => o.id === id)) return;
  state.exclude.add(id);
  rebuildLocal();
  toast('Hidden. A related paper took its place. Undo it in Filters');
}
function renderHidden() {
  const n = state.exclude.size;
  $('#hidden-row').hidden = !n;
  $('#hidden-count').textContent = `${n} paper${n === 1 ? '' : 's'} hidden`;
  updateFilterSummary();
}
$('#unhide-all').addEventListener('click', () => { state.exclude = new Set(); rebuildLocal(); });

// ---- filters: year range and free full text; they narrow the lists and light up the graph ----
const passesFilters = (w) => {
  const { from, to, oa } = state.filters;
  if (from && !(w.publication_year >= from)) return false;
  if (to && !(w.publication_year <= to)) return false;
  if (oa && !w.open_access?.oa_url) return false;
  return true;
};
const filtersOn = () => !!(state.filters.from || state.filters.to || state.filters.oa);
function updateFilterSummary() {
  const f = state.filters, bits = [];
  if (f.from || f.to) bits.push(`${f.from || '…'}–${f.to || '…'}`);
  if (f.oa) bits.push('free');
  if (state.exclude.size) bits.push(`${state.exclude.size} hidden`);
  $('#filter-summary').textContent = bits.length ? `· ${bits.join(', ')}` : '';
}
function applyFilters() {
  updateFilterSummary();
  renderList();
  if (!state.graph) return;
  const f = state.filter.toLowerCase().trim();
  state.topicFocus = null;
  if (!f && !filtersOn()) { view.highlight(null); renderLegend(); return; }
  const ids = new Set(state.lists.graph.filter((w) => passesFilters(w) && (!f || matches(w, f))).map((w) => w.id));
  view.select(null);
  view.highlight(ids.size ? ids : new Set(['none']));
  renderLegend();
}
function readFilters() {
  const n = (v) => (/^\d{4}$/.test(v.trim()) ? Number(v) : null);
  state.filters = { from: n($('#year-from').value), to: n($('#year-to').value), oa: $('#oa-only').checked };
  applyFilters();
}
['#year-from', '#year-to'].forEach((sel) => $(sel).addEventListener('input', readFilters));
$('#oa-only').addEventListener('change', readFilters);
$('#clear-filters').addEventListener('click', () => {
  $('#year-from').value = ''; $('#year-to').value = ''; $('#oa-only').checked = false;
  readFilters();
});

// ---- rendering ----
function renderOrigin() {
  const os = state.origins;
  if (os.length === 1) {
    const o = os[0];
    $('#origin-card').innerHTML = `
      <div class="kicker">Origin paper</div>
      <div class="t">${esc(stripTags(o.title))}</div>
      <div class="m">${esc(shortLabel(o))} · ${esc(venue(o))}</div>`;
    return;
  }
  $('#origin-card').innerHTML = `
    <div class="kicker">${os.length} origin papers</div>
    <ul class="origins">${os.map((o) => `<li><button data-pick="${o.id}" title="${esc(stripTags(o.title))}"><b>${esc(shortLabel(o))}</b> ${esc(stripTags(o.title))}</button></li>`).join('')}</ul>`;
}
$('#origin-card').addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) selectPaper(b.dataset.pick); });

function renderLegend() {
  const lg = view.legend();
  if (!lg) { $('#legend').innerHTML = ''; return; }
  const head = `<button class="legend-head" aria-expanded="${prefs.legendOpen}">${esc(lg.title)}<span>${prefs.legendOpen ? '▾' : '▸'}</span></button>`;
  if (!prefs.legendOpen) { $('#legend').innerHTML = head; return; }
  const footer = '<div class="row hide-sm"><span>Size: citations</span><span>Lines: similarity</span></div>';
  if (lg.type === 'ramp') {
    const stops = [0, 0.33, 0.66, 1].map((t) => lg.interp(t)).join(',');
    $('#legend').innerHTML = `${head}
      <div class="row"><span>${esc(lg.lo)}</span><span class="ramp" style="background:linear-gradient(90deg,${stops})"></span><span>${esc(lg.hi)}</span></div>${footer}`;
  } else {
    $('#legend').innerHTML = `${head}
      <div class="cats">${lg.cats.map((c) => `
        <button class="cat ${state.topicFocus === c.label ? 'on' : ''}" data-topic="${esc(c.label)}" ${c.other ? 'data-other="1"' : ''} title="Highlight ${esc(c.label)}">
          <i style="background:${c.color}"></i><span>${esc(c.label)}</span><em>${c.count}</em>
        </button>`).join('')}</div>${footer}`;
  }
}
$('#legend').addEventListener('click', (e) => {
  if (e.target.closest('.legend-head')) { setPref('legendOpen', !prefs.legendOpen); renderLegend(); return; }
  const b = e.target.closest('.cat');
  if (!b) return;
  const lg = view.legend();
  const t = b.dataset.topic;
  state.topicFocus = state.topicFocus === t ? null : t;
  if (!state.topicFocus) view.highlight(null);
  else {
    const ids = new Set(state.lists.graph.filter((n) => (b.dataset.other ? topicOf(n) && !lg.top.includes(topicOf(n)) : topicOf(n) === t)).map((n) => n.id));
    view.select(null); state.selected = null;
    view.highlight(ids);
  }
  renderLegend();
});

const TAB_HELP = {
  graph: 'Papers in the graph, ranked by similarity to the origin paper.',
  prior: 'Papers cited by many papers in the graph. Usually the foundational work of the field.',
  derivative: 'Papers that cite many papers in the graph. Usually recent reviews and follow-up work.',
  saved: 'Papers you starred, from any graph. Kept in this browser. Export them to your reference manager.',
};

function listFor(tab) { return tab === 'saved' ? [...saved.values()] : state.lists[tab]; }
const matches = (w, f) => `${stripTags(w.title)} ${authorNames(w).join(' ')} ${venue(w)} ${w.publication_year} ${topicOf(w) || ''}`.toLowerCase().includes(f);

function currentList() {
  const raw = listFor(state.tab);
  if (!Array.isArray(raw)) return raw;
  const f = state.filter.toLowerCase().trim();
  const list = raw.filter((w) => (!f || matches(w, f)) && (state.tab === 'saved' || passesFilters(w)));
  const by = {
    sim: (a, b) => (b.simToOrigin ?? b.graphCount ?? 0) - (a.simToOrigin ?? a.graphCount ?? 0),
    cites: (a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0),
    new: (a, b) => (b.publication_year || 0) - (a.publication_year || 0),
    old: (a, b) => (a.publication_year || 9999) - (b.publication_year || 9999),
  }[state.sort];
  return state.tab === 'saved' && state.sort === 'sim' ? list : list.sort(by);
}

function renderList() {
  for (const t of ['graph', 'prior', 'derivative', 'saved']) {
    const l = listFor(t);
    $(`#count-${t}`).textContent = Array.isArray(l) && l.length ? l.length : '';
  }
  $('#tab-help').textContent = TAB_HELP[state.tab];
  $('#build-saved').hidden = !(state.tab === 'saved' && saved.size >= 1);
  $('#build-saved').textContent = saved.size > MAX_ORIGINS ? `Build a graph from your ${MAX_ORIGINS} newest saved papers` : `Build a graph from ${saved.size === 1 ? 'this paper' : `these ${saved.size} papers`}`;
  $('#sort-select').options[0].textContent = { graph: 'Most similar', saved: 'Order saved' }[state.tab] || 'Most connected';
  $('#export-label').textContent = state.tab === 'saved' ? 'Export saved' : 'Export list';
  const ol = $('#paper-list');
  const list = currentList();
  if (list === null || list === undefined) { ol.innerHTML = '<li class="empty-row">Loading…</li>'; return; }
  if (list.error) { ol.innerHTML = `<li class="empty-row"><span class="error">${esc(list.error)}</span></li>`; return; }
  if (!list.length) {
    const msg = state.tab === 'saved' ? 'No saved papers yet. Click ☆ on any paper to keep it here.'
      : state.filter || filtersOn() ? 'No papers match the filters.' : state.graph ? 'Nothing here for this paper.' : '';
    ol.innerHTML = `<li class="empty-row">${msg}</li>`; return;
  }
  const inGraph = new Set(state.lists.graph.map((n) => n.id));
  ol.innerHTML = list.map((w) => `
    <li data-id="${w.id}" class="${w.id === state.selected ? 'selected' : ''}" tabindex="0">
      <span class="dot" style="background:${inGraph.has(w.id) || state.graph ? view.colorOf(w) : 'var(--muted)'}"></span>
      <div>
        <div class="t">${esc(stripTags(w.title))}</div>
        <div class="m">${esc(shortLabel(w))} · ${w.cited_by_count ?? 0} cites${w.graphCount ? ` · <span class="badge">${state.tab === 'prior' ? 'cited by' : 'cites'} ${w.graphCount} in graph</span>` : ''}${state.tab !== 'graph' && inGraph.has(w.id) ? ' · <span class="badge">in graph</span>' : ''}${w.isOrigin ? ' · <span class="badge">origin</span>' : ''}${w.open_access?.oa_url ? ' · <span class="badge oa">free PDF</span>' : ''}</div>
        ${state.tab === 'graph' ? `<div class="bar" style="width:${Math.round((w.simPct ?? 0) * 100)}%"></div>` : ''}
      </div>
      <button class="star ${isSaved(w.id) ? 'on' : ''}" data-star="${w.id}" aria-label="${isSaved(w.id) ? 'Remove from saved' : 'Save paper'}" title="${isSaved(w.id) ? 'Remove from saved' : 'Save paper'}">${isSaved(w.id) ? '★' : '☆'}</button>
    </li>`).join('');
}

$('#paper-list').addEventListener('click', (e) => {
  const star = e.target.closest('[data-star]');
  if (star) { e.stopPropagation(); toggleSaved(findWork(star.dataset.star)); return; }
  const li = e.target.closest('li[data-id]');
  if (li) selectPaper(li.dataset.id);
});
$('#paper-list').addEventListener('keydown', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li && e.key === 'Enter' && !e.target.closest('[data-star]')) selectPaper(li.dataset.id);
});
$('#filter-input').addEventListener('input', (e) => { state.filter = e.target.value; applyFilters(); });
$('#sort-select').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
function setTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((x) => { const on = x.dataset.tab === tab; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on)); });
  renderList();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

function findWork(id) {
  for (const l of Object.values(state.lists)) if (Array.isArray(l)) { const w = l.find((x) => x.id === id); if (w) return w; }
  return state.graph?.corpus.get(id) || saved.get(id) || null;
}

function selectPaper(id, { fromGraph = false } = {}) {
  state.selected = id;
  if (!fromGraph) view.select(id && state.lists.graph.some((n) => n.id === id) ? id : null);
  $$('#paper-list li').forEach((li) => li.classList.toggle('selected', li.dataset.id === id));
  if (id) document.querySelector(`#paper-list li[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  if (id && prefs.hideRight && innerWidth > 720) setPanels(prefs.hideLeft, false);
  renderDetail();
}

async function renderDetail() {
  const box = $('#detail');
  const w = state.selected && findWork(state.selected);
  if (!w) { box.innerHTML = state.graph ? '<p class="empty">Click a paper in the graph or a list to see its details. Double-click a node to build a new graph from it.</p>' : ''; return; }
  const authors = authorNames(w);
  const inGraph = state.lists.graph.some((n) => n.id === w.id);
  const oa = w.open_access?.oa_url;
  const topic = topicOf(w);
  box.innerHTML = `
    ${w.isOrigin ? '<div class="kicker">Origin paper</div>' : ''}
    <h2>${esc(stripTags(w.title))}</h2>
    <div class="m">${esc(venue(w))}${venue(w) ? ' · ' : ''}${w.publication_year ?? ''}</div>
    <div class="authors">${authorList(w).slice(0, 8).map((a) => (a.id ? `<button class="author" data-author="${esc(a.id)}" title="See ${esc(a.name)}'s papers">${esc(a.name)}</button>` : esc(a.name))).join(', ')}${authors.length > 8 ? ` and ${authors.length - 8} more` : ''}</div>
    ${topic ? `<span class="topic"><i style="background:${view.colorOf(w)}"></i>${esc(topic)}</span>` : ''}
    <div class="stats">
      <div class="stat"><b>${(w.cited_by_count ?? 0).toLocaleString()}</b><span>citations</span></div>
      ${w.referenced_works?.length ? `<div class="stat"><b>${w.referenced_works.length}</b><span>references</span></div>` : ''}
      ${inGraph && !w.isOrigin ? `<div class="stat"><b>${Math.round((w.simPct ?? 0) * 100)}%</b><span>similarity rank</span></div>` : ''}
    </div>
    <div class="actions">
      ${w.isOrigin && state.origins.length === 1 ? '' : '<button class="btn accent small" id="d-build">Build graph from this paper</button>'}
      ${state.graph && !w.isOrigin && state.origins.length < MAX_ORIGINS ? '<button class="btn small" id="d-add" title="Rebuild the graph around the origin papers and this one">＋ Add as origin</button>' : ''}
      <button class="btn small" id="d-star">${isSaved(w.id) ? '★ Saved' : '☆ Save'}</button>
      <button class="btn small" id="d-bib">Copy BibTeX</button>
      <button class="btn small" id="d-ris">Download RIS</button>
      ${inGraph && !w.isOrigin ? '<button class="btn small ghost" id="d-hide" title="Remove from this graph; the next most similar paper takes its place (H)">Hide from graph</button>' : ''}
    </div>
    <div class="links">
      ${oa ? `<a class="oa" href="${esc(oa)}" target="_blank" rel="noopener">Free full text ↗</a>` : ''}
      ${doiUrl(w) ? `<a href="${esc(doiUrl(w))}" target="_blank" rel="noopener">Publisher page</a>` : ''}
      <a href="https://openalex.org/${w.id}" target="_blank" rel="noopener">OpenAlex</a>
      <a href="https://scholar.google.com/scholar?q=${encodeURIComponent(stripTags(w.title))}" target="_blank" rel="noopener">Google Scholar</a>
    </div>
    <h3>Abstract</h3>
    <div class="abstract" id="d-abstract">${w.abstract_inverted_index ? esc(abstractFrom(w.abstract_inverted_index)) : '<span class="m">Loading…</span>'}</div>`;
  $('#d-build')?.addEventListener('click', () => go(w.id));
  $('#d-add')?.addEventListener('click', () => go([...state.origins.map((o) => o.id), w.id]));
  $('#d-hide')?.addEventListener('click', () => hidePaper(w.id));
  box.querySelectorAll('[data-author]').forEach((b) => b.addEventListener('click', () => openAuthor(b.dataset.author)));
  $('#d-star').addEventListener('click', () => toggleSaved(w));
  $('#d-bib').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(toBibTeX([w])); toast('BibTeX copied'); }
    catch { download(`${w.id}.bib`, toBibTeX([w])); }
  });
  $('#d-ris').addEventListener('click', () => download(`${w.id}.ris`, toRIS([w]), 'application/x-research-info-systems'));
  if (w.abstract_inverted_index === undefined) {
    try {
      const full = await getWork(w.id); // single lookups are free
      w.abstract_inverted_index = full.abstract_inverted_index || null;
      if (!w.referenced_works?.length) w.referenced_works = full.referenced_works;
      if (state.selected !== w.id) return;
      $('#d-abstract').innerHTML = w.abstract_inverted_index ? esc(abstractFrom(w.abstract_inverted_index)) : '<span class="m">No abstract available in OpenAlex.</span>';
    } catch { if (state.selected === w.id) $('#d-abstract').innerHTML = '<span class="m">Abstract unavailable.</span>'; }
  } else if (!w.abstract_inverted_index) {
    $('#d-abstract').innerHTML = '<span class="m">No abstract available in OpenAlex.</span>';
  }
}

// ---- graph toolbar ----
function syncToolbar() {
  $$('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === prefs.colorMode));
  $$('[data-layout]').forEach((b) => b.classList.toggle('on', b.dataset.layout === prefs.layout));
  $('#labels-toggle').checked = prefs.labels;
  $('#map-axes').hidden = prefs.layout !== 'map';
}
$$('[data-color]').forEach((b) => b.addEventListener('click', () => {
  setPref('colorMode', b.dataset.color);
  state.topicFocus = null; view.highlight(null);
  view.setColorMode(prefs.colorMode);
  syncToolbar(); renderLegend(); renderList(); renderDetail();
}));
function setLayout(mode) {
  setPref('layout', mode);
  view.setLayout(mode);
  syncToolbar();
}
const axisOptions = (sel) => Object.entries(MAP_METRICS).map(([k, m]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${m.label}</option>`).join('');
$('#map-x').innerHTML = axisOptions(prefs.mapX);
$('#map-y').innerHTML = axisOptions(prefs.mapY);
['x', 'y'].forEach((ax) => $(`#map-${ax}`).addEventListener('change', (e) => {
  setPref(ax === 'x' ? 'mapX' : 'mapY', e.target.value);
  view.setMapAxes({ [ax]: e.target.value });
}));
$$('[data-layout]').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));
$('#labels-toggle').addEventListener('change', (e) => { setPref('labels', e.target.checked); view.setLabels(e.target.checked); });

// ---- collapsible panels ----
function setPanels(hideLeft, hideRight) {
  setPref('hideLeft', hideLeft); setPref('hideRight', hideRight);
  const ws = $('#workspace');
  ws.classList.toggle('hide-left', hideLeft);
  ws.classList.toggle('hide-right', hideRight);
  const l = $('#toggle-left'), r = $('#toggle-right');
  l.textContent = hideLeft ? '▶' : '◀';
  r.textContent = hideRight ? '◀' : '▶';
  l.setAttribute('aria-label', hideLeft ? 'Show paper lists' : 'Hide paper lists'); l.title = l.getAttribute('aria-label') + ' ([)';
  r.setAttribute('aria-label', hideRight ? 'Show paper details' : 'Hide paper details'); r.title = r.getAttribute('aria-label') + ' (])';
  l.setAttribute('aria-expanded', String(!hideLeft)); r.setAttribute('aria-expanded', String(!hideRight));
  setTimeout(() => view.fit(), 230); // after the panel animation
}
$('#toggle-left').addEventListener('click', () => setPanels(!prefs.hideLeft, prefs.hideRight));
$('#toggle-right').addEventListener('click', () => setPanels(prefs.hideLeft, !prefs.hideRight));

// ---- exports ----
$$('[data-export]').forEach((b) => b.addEventListener('click', () => {
  const list = currentList();
  if (!Array.isArray(list) || !list.length) return toast('Nothing to export yet');
  const base = state.tab === 'saved' ? 'rhizome-saved' : `rhizome-${state.origin.id}${state.origins.length > 1 ? `-plus${state.origins.length - 1}` : ''}-${state.tab}`;
  const kind = b.dataset.export;
  if (kind === 'bib') download(`${base}.bib`, toBibTeX(list), 'application/x-bibtex');
  if (kind === 'ris') download(`${base}.ris`, toRIS(list), 'application/x-research-info-systems');
  if (kind === 'csv') download(`${base}.csv`, toCSV(list), 'text/csv');
  toast(`Exported ${list.length} papers`);
}));
$('#zoom-in').addEventListener('click', () => view.zoomBy(1.3));
$('#zoom-out').addEventListener('click', () => view.zoomBy(1 / 1.3));
$('#zoom-fit').addEventListener('click', () => view.fit());
$('#share-btn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); toast('Link to this graph copied'); }
  catch { toast(location.href); }
});

// ---- keyboard shortcuts ----
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'Escape') {
    if (typing) e.target.blur();
    else if (state.graph) { state.topicFocus = null; view.highlight(null); selectPaper(null); renderLegend(); }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || $$('dialog').some((d) => d.open)) return;
  if (e.key === '/') { e.preventDefault(); $('#search-input').focus(); $('#search-input').select(); return; }
  if ($('#workspace').hidden) return;
  if (e.key === 'f' || e.key === 'F') view.fit();
  if (e.key === 't' || e.key === 'T') setLayout(prefs.layout === 'timeline' ? 'similarity' : 'timeline');
  if (e.key === 'm' || e.key === 'M') setLayout(prefs.layout === 'map' ? 'similarity' : 'map');
  if ((e.key === 'h' || e.key === 'H') && state.selected) hidePaper(state.selected);
  if ((e.key === 's' || e.key === 'S') && state.selected) toggleSaved(findWork(state.selected));
  if (e.key === '[') setPanels(!prefs.hideLeft, prefs.hideRight);
  if (e.key === ']') setPanels(prefs.hideLeft, !prefs.hideRight);
});

// ---- settings ----
$('#settings-btn').addEventListener('click', () => {
  $('#opt-size').value = String(prefs.size);
  $('#opt-key').value = settings.apiKey;
  $('#usage-line').textContent = usage.calls ? `This visit: ${usage.calls} OpenAlex requests, about $${usage.costUsd.toFixed(4)} of the free daily budget.` : '';
  $('#settings').showModal();
});
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  const newSize = Number($('#opt-size').value);
  settings.apiKey = $('#opt-key').value.trim();
  store.set('apiKey', settings.apiKey);
  if (newSize !== prefs.size) {
    setPref('size', newSize);
    if (state.key) { state.graph = null; loadGraph(state.key); }
  }
});

// ---- several origin papers: paste, import from a reference manager, or use saved ----
const DOI_RE = /10\.\d{4,9}\/[^\s"<>{}]+/g;
function idsFromText(text) {
  const dois = [...new Set((text.match(DOI_RE) || []).map((d) => d.replace(/[.,;)\]]+$/, '').toLowerCase()))];
  const ids = [...new Set((text.match(/\bW\d{4,}\b/gi) || []).map((x) => x.toUpperCase()))];
  return { dois, ids };
}
function multiPreview() {
  const { dois, ids } = idsFromText($('#multi-text').value);
  const n = dois.length + ids.length;
  $('#multi-status').textContent = n ? `${n} paper${n === 1 ? '' : 's'} recognised${n > MAX_ORIGINS ? `; the first ${MAX_ORIGINS} will be used` : ''}.` : '';
  $('#multi-go').disabled = !n;
}
$('#multi-open').addEventListener('click', () => { multiPreview(); $('#multi').showModal(); $('#multi-text').focus(); });
$('#multi-text').addEventListener('input', multiPreview);
$('#multi-saved').addEventListener('click', () => {
  if (!saved.size) { $('#multi-status').textContent = 'You have no saved papers yet. Star papers in any graph to collect them.'; return; }
  const add = [...saved.values()].map((w) => bareDoi(w) || w.id).join('\n');
  $('#multi-text').value = [$('#multi-text').value.trim(), add].filter(Boolean).join('\n');
  multiPreview();
});
$('#multi-file').addEventListener('change', async (e) => {
  let entries = 0, text = '';
  for (const f of e.target.files) {
    const t = await f.text();
    text += '\n' + t;
    entries += (t.match(/^\s*@\w+\s*\{/gm) || []).length + (t.match(/^TY {2}- /gm) || []).length;
  }
  const { dois, ids } = idsFromText(text);
  $('#multi-text').value = [$('#multi-text').value.trim(), ...dois, ...ids].filter(Boolean).join('\n');
  multiPreview();
  const found = dois.length + ids.length;
  if (entries > found) $('#multi-status').textContent += ` ${entries - found} of ${entries} entries had no DOI and were skipped.`;
  e.target.value = '';
});
// Act on the submit itself: the dialog's close event can be delayed in background tabs.
$('#multi form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'go') return;
  const { dois, ids } = idsFromText($('#multi-text').value);
  startFromMany(dois, ids);
});
async function startFromMany(dois, ids) {
  const box = $('#search-results');
  showLanding();
  box.hidden = false;
  box.innerHTML = '<p class="m">Looking up the papers…</p>';
  try {
    const found = dois.length ? await getWorksByDois(dois.slice(0, MAX_ORIGINS * 2)) : [];
    const all = [...new Set([...ids, ...found.map((w) => w.id)])].slice(0, MAX_ORIGINS);
    if (!all.length) { box.innerHTML = '<p class="error">None of those papers were found in OpenAlex. Check the DOIs.</p>'; return; }
    const missing = dois.length - found.length;
    box.hidden = true;
    if (missing > 0) toast(`${missing} DOI${missing === 1 ? ' was' : 's were'} not found in OpenAlex and left out`);
    go(all);
  } catch (err) {
    box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}
$('#build-saved').addEventListener('click', () => {
  const list = [...saved.values()].slice(-MAX_ORIGINS);
  go(list.map((w) => w.id));
});

// ---- author pages ----
let authorRun = 0;
async function openAuthor(id, sort = 'cited_by_count:desc') {
  const run = ++authorRun;
  const body = $('#author-body');
  if (!$('#author').open) { body.innerHTML = '<p class="m">Loading author…</p>'; $('#author').showModal(); }
  try {
    const [a, works] = await Promise.all([getAuthor(id), getAuthorWorks(id, { sort, n: 50 })]);
    if (run !== authorRun) return;
    const inst = a.last_known_institutions?.[0]?.display_name;
    const topics = (a.topics || []).slice(0, 4).map((t) => t.display_name);
    const top5 = [...works].sort((x, y) => (y.cited_by_count || 0) - (x.cited_by_count || 0)).slice(0, 5).map((w) => w.id);
    body.innerHTML = `
      <div class="kicker">Author</div>
      <h2>${esc(a.display_name)}</h2>
      <div class="m">${inst ? esc(inst) : ''}</div>
      <div class="stats">
        <div class="stat"><b>${(a.works_count ?? 0).toLocaleString()}</b><span>works</span></div>
        <div class="stat"><b>${(a.cited_by_count ?? 0).toLocaleString()}</b><span>citations</span></div>
        ${a.summary_stats?.h_index != null ? `<div class="stat"><b>${a.summary_stats.h_index}</b><span>h-index</span></div>` : ''}
      </div>
      ${topics.length ? `<p class="m">Works on ${esc(topics.join(', '))}</p>` : ''}
      <div class="actions">
        ${top5.length > 1 ? `<button class="btn accent small" id="a-build">Map their ${top5.length} most cited papers</button>` : ''}
        <a class="btn small" href="https://openalex.org/${esc(a.id)}" target="_blank" rel="noopener">OpenAlex profile</a>
        ${a.orcid ? `<a class="btn small" href="${esc(a.orcid)}" target="_blank" rel="noopener">ORCID</a>` : ''}
      </div>
      <div class="seg author-sort" role="group" aria-label="Sort works">
        <button data-asort="cited_by_count:desc" class="${sort.startsWith('cited') ? 'on' : ''}">Most cited</button>
        <button data-asort="publication_date:desc" class="${sort.startsWith('publication') ? 'on' : ''}">Newest</button>
      </div>
      <ol class="paper-list author-works">${works.map((w) => `
        <li data-id="${w.id}" tabindex="0">
          <span class="dot" style="background:var(--accent)"></span>
          <div><div class="t">${esc(stripTags(w.title))}</div>
          <div class="m">${w.publication_year ?? ''} · ${esc(venue(w))} · ${w.cited_by_count ?? 0} cites${w.open_access?.oa_url ? ' · <span class="badge oa">free PDF</span>' : ''}</div></div>
          <button class="star ${isSaved(w.id) ? 'on' : ''}" data-astar="${w.id}" aria-label="Save paper" title="Save paper">${isSaved(w.id) ? '★' : '☆'}</button>
        </li>`).join('')}</ol>
      <p class="hint">Click a paper to build its graph.</p>`;
    $('#a-build')?.addEventListener('click', () => { $('#author').close(); go(top5); });
    body.querySelectorAll('[data-asort]').forEach((b) => b.addEventListener('click', () => openAuthor(id, b.dataset.asort)));
    body.querySelector('.author-works').addEventListener('click', (e) => {
      const star = e.target.closest('[data-astar]');
      if (star) { const w = works.find((x) => x.id === star.dataset.astar); toggleSaved(w); star.textContent = isSaved(w.id) ? '★' : '☆'; star.classList.toggle('on', isSaved(w.id)); return; }
      const li = e.target.closest('li[data-id]');
      if (li) { $('#author').close(); go(li.dataset.id); }
    });
  } catch (err) {
    if (run === authorRun) body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function toast(msg) {
  $$('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ---- boot ----
renderThemeMenu();
syncToolbar();
renderTrail();
setPanels(prefs.hideLeft, prefs.hideRight);
route();
