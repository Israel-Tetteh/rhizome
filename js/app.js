import {
  settings, usage, getWork, searchWorks, resolveViaSemanticScholar, abstractFrom,
  authorNames, shortLabel, venue, doiUrl, ApiError,
} from './openalex.js';
import { buildGraph, priorWorks, derivativeWorks } from './graph-builder.js';
import { createGraphView, topicOf } from './graph-view.js';
import { toBibTeX, toRIS, toCSV, download } from './export.js';

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
};
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
  origin: null, graph: null,
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
function go(id) { location.hash = `#/${id}`; }
window.addEventListener('hashchange', route);
async function route() {
  const m = location.hash.match(/^#\/(W\d+)/i);
  if (!m) return showLanding();
  if (state.graph?.nodes[0]?.id === m[1].toUpperCase()) return;
  await loadGraph(m[1].toUpperCase());
}

function showLanding() {
  $('#landing').hidden = false; $('#workspace').hidden = true;
  document.title = 'Rhizome · paper graphs';
  renderRecent();
}

// ---- recent graphs ----
function remember(origin) {
  const list = store.get('recent', []).filter((r) => r.id !== origin.id);
  list.unshift({ id: origin.id, title: stripTags(origin.title), label: shortLabel(origin), venue: venue(origin), at: Date.now() });
  store.set('recent', list.slice(0, 9));
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

async function loadGraph(id) {
  const run = ++state.runId;
  $('#landing').hidden = true; $('#workspace').hidden = false;
  steps = []; $('#status-text').textContent = '';
  setStatus('Fetching the paper…');
  state.lists = { graph: [], prior: null, derivative: null };
  state.selected = null; state.graph = null; state.topicFocus = null;
  $('#filter-input').value = ''; state.filter = '';
  renderList(); renderDetail();
  try {
    const origin = state.origin?.id === id && state.origin.referenced_works ? state.origin : await getWork(id);
    if (run !== state.runId) return;
    state.origin = origin;
    document.title = `${stripTags(origin.title).slice(0, 60)} · Rhizome`;
    renderOrigin();
    $('#search-input').value = bareDoi(origin) || origin.id;
    const graph = await buildGraph(origin, { size: prefs.size, onProgress: (t) => run === state.runId && setStatus(t) });
    if (run !== state.runId) return;
    if (graph.nodes.length < 2) {
      setStatus('');
      $('#detail').innerHTML = `<p class="error">OpenAlex has too little citation data for this paper to build a graph (it lists ${origin.referenced_works.length} references and ${origin.cited_by_count ?? 0} citations). Try a related paper instead.</p>`;
      return;
    }
    state.graph = graph;
    state.lists.graph = graph.nodes;
    view.setColorMode(prefs.colorMode);
    view.setLabels(prefs.labels);
    view.render(graph);
    if (prefs.layout !== 'similarity') view.setLayout(prefs.layout);
    remember(origin);
    renderLegend();
    setStatus('');
    selectPaper(origin.id, { fromGraph: true }); // show its details without dimming the graph
    renderList();
    priorWorks(graph).then((l) => { if (run === state.runId) { state.lists.prior = l; renderList(); } })
      .catch((e) => { if (run === state.runId) { state.lists.prior = { error: e.message }; renderList(); } });
    derivativeWorks(graph).then((l) => { if (run === state.runId) { state.lists.derivative = l; renderList(); } })
      .catch((e) => { if (run === state.runId) { state.lists.derivative = { error: e.message }; renderList(); } });
  } catch (err) {
    if (run !== state.runId) return;
    setStatus('');
    $('#detail').innerHTML = `<p class="error">${esc(err.message)}</p><p><a href="./" id="back">Back to search</a></p>`;
    $('#back').addEventListener('click', (e) => { e.preventDefault(); history.pushState('', '', location.pathname); showLanding(); });
  }
}

// ---- rendering ----
function renderOrigin() {
  const o = state.origin;
  $('#origin-card').innerHTML = `
    <div class="kicker">Origin paper</div>
    <div class="t">${esc(stripTags(o.title))}</div>
    <div class="m">${esc(shortLabel(o))} · ${esc(venue(o))}</div>`;
}

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
  const list = f ? raw.filter((w) => matches(w, f)) : [...raw];
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
  $('#sort-select').options[0].textContent = { graph: 'Most similar', saved: 'Order saved' }[state.tab] || 'Most connected';
  $('#export-label').textContent = state.tab === 'saved' ? 'Export saved' : 'Export list';
  const ol = $('#paper-list');
  const list = currentList();
  if (list === null || list === undefined) { ol.innerHTML = '<li class="empty-row">Loading…</li>'; return; }
  if (list.error) { ol.innerHTML = `<li class="empty-row"><span class="error">${esc(list.error)}</span></li>`; return; }
  if (!list.length) {
    const msg = state.tab === 'saved' ? 'No saved papers yet. Click ☆ on any paper to keep it here.'
      : state.filter ? 'No papers match that filter.' : state.graph ? 'Nothing here for this paper.' : '';
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
$('#filter-input').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderList();
  const f = state.filter.toLowerCase().trim();
  state.topicFocus = null;
  if (state.graph) {
    view.highlight(f ? new Set(state.lists.graph.filter((w) => matches(w, f)).map((w) => w.id)) : null);
    if (f) { view.select(null); }
    renderLegend();
  }
});
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
    <div class="authors">${esc(authors.slice(0, 8).join(', '))}${authors.length > 8 ? ` and ${authors.length - 8} more` : ''}</div>
    ${topic ? `<span class="topic"><i style="background:${view.colorOf(w)}"></i>${esc(topic)}</span>` : ''}
    <div class="stats">
      <div class="stat"><b>${(w.cited_by_count ?? 0).toLocaleString()}</b><span>citations</span></div>
      ${w.referenced_works?.length ? `<div class="stat"><b>${w.referenced_works.length}</b><span>references</span></div>` : ''}
      ${inGraph && !w.isOrigin ? `<div class="stat"><b>${Math.round((w.simPct ?? 0) * 100)}%</b><span>similarity rank</span></div>` : ''}
    </div>
    <div class="actions">
      ${w.isOrigin ? '' : '<button class="btn accent small" id="d-build">Build graph from this paper</button>'}
      <button class="btn small" id="d-star">${isSaved(w.id) ? '★ Saved' : '☆ Save'}</button>
      <button class="btn small" id="d-bib">Copy BibTeX</button>
      <button class="btn small" id="d-ris">Download RIS</button>
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
  const base = state.tab === 'saved' ? 'rhizome-saved' : `rhizome-${state.origin.id}-${state.tab}`;
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
  if (typing || e.metaKey || e.ctrlKey || e.altKey || $('#settings').open) return;
  if (e.key === '/') { e.preventDefault(); $('#search-input').focus(); $('#search-input').select(); return; }
  if ($('#workspace').hidden) return;
  if (e.key === 'f' || e.key === 'F') view.fit();
  if (e.key === 't' || e.key === 'T') setLayout(prefs.layout === 'timeline' ? 'similarity' : 'timeline');
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
    if (state.origin) { state.graph = null; loadGraph(state.origin.id); }
  }
});

function toast(msg) {
  $$('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ---- boot ----
renderThemeMenu();
syncToolbar();
setPanels(prefs.hideLeft, prefs.hideRight);
route();
