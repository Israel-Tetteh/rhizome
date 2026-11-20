import {
  settings, usage, getWork, searchWorks, resolveViaSemanticScholar, abstractFrom,
  authorNames, shortLabel, venue, doiUrl, ApiError,
} from './openalex.js';
import { buildGraph, priorWorks, derivativeWorks } from './graph-builder.js';
import { createGraphView, yearScale } from './graph-view.js';
import { toBibTeX, toRIS, toCSV, download } from './export.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '');

// ---- persisted preferences (per browser, optional) ----
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('rhizome:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rhizome:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
settings.apiKey = store.get('apiKey', '');
const prefs = { size: store.get('size', 40) };

// ---- state ----
const state = {
  origin: null, graph: null, color: null,
  lists: { graph: [], prior: null, derivative: null },
  tab: 'graph', sort: 'sim', filter: '', selected: null, runId: 0,
};

const view = createGraphView($('#graph'), {
  onSelect: (id) => selectPaper(id, { fromGraph: true }),
  onOpen: (id) => go(id),
});

// ---- input parsing ----
function parseInput(raw) {
  const s = raw.trim();
  let m;
  if ((m = s.match(/(10\.\d{4,9}\/[^\s"<>]+)/))) return { kind: 'doi', value: m[1].replace(/[.,;]+$/, '') };
  if ((m = s.match(/(?:openalex\.org\/(?:works\/)?|^)(W\d{4,})\b/i))) return { kind: 'openalex', value: m[1].toUpperCase() };
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
}

// ---- search form ----
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); startFrom($('#search-input').value); });
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { $('#search-input').value = c.dataset.q; startFrom(c.dataset.q); }));
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
function setStatus(text) {
  $('#status').hidden = !text;
  $('#status-text').textContent = text || '';
}

async function loadGraph(id) {
  const run = ++state.runId;
  $('#landing').hidden = true; $('#workspace').hidden = false;
  setStatus('Fetching the paper…');
  state.lists = { graph: [], prior: null, derivative: null };
  state.selected = null;
  renderList(); renderDetail();
  try {
    const origin = state.origin?.id === id && state.origin.referenced_works ? state.origin : await getWork(id);
    if (run !== state.runId) return;
    state.origin = origin;
    document.title = `${stripTags(origin.title).slice(0, 60)} · Rhizome`;
    renderOrigin();
    const graph = await buildGraph(origin, { size: prefs.size, onProgress: (t) => run === state.runId && setStatus(t) });
    if (run !== state.runId) return;
    if (graph.nodes.length < 2) {
      setStatus('');
      $('#detail').innerHTML = `<p class="error">OpenAlex has too little citation data for this paper to build a graph (it lists ${origin.referenced_works.length} references and ${origin.cited_by_count ?? 0} citations). Try a related paper instead.</p>`;
      return;
    }
    state.graph = graph;
    state.color = view.render(graph);
    state.lists.graph = graph.nodes;
    renderLegend();
    setStatus('');
    selectPaper(origin.id);
    renderList();
    // fill the other two lists in the background
    priorWorks(graph).then((l) => { if (run === state.runId) { state.lists.prior = l; renderList(); } })
      .catch((e) => { if (run === state.runId) { state.lists.prior = { error: e.message }; renderList(); } });
    derivativeWorks(graph).then((l) => { if (run === state.runId) { state.lists.derivative = l; renderList(); } })
      .catch((e) => { if (run === state.runId) { state.lists.derivative = { error: e.message }; renderList(); } });
  } catch (err) {
    if (run !== state.runId) return;
    setStatus('');
    $('#detail').innerHTML = `<p class="error">${esc(err.message)}</p><p><a href="#" id="back">Back to search</a></p>`;
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
  const c = state.color;
  const stops = [0, .33, .66, 1].map((t) => c.interp(t)).join(',');
  $('#legend').innerHTML = `
    <div class="row"><span>${c.lo}</span><span class="ramp" style="background:linear-gradient(90deg,${stops})"></span><span>${c.hi}</span></div>
    <div class="row"><span>Colour: year</span><span>Size: citations</span></div>
    <div class="row"><span>Lines and closeness: similarity</span></div>`;
}

const TAB_HELP = {
  graph: 'Papers in the graph, ranked by similarity to the origin paper.',
  prior: 'Papers cited by many papers in the graph. Usually the foundational work of the field.',
  derivative: 'Papers that cite many papers in the graph. Usually recent reviews and follow-up work.',
};

function currentList() {
  const raw = state.lists[state.tab];
  if (!Array.isArray(raw)) return raw;
  const f = state.filter.toLowerCase();
  let list = f ? raw.filter((w) => `${stripTags(w.title)} ${authorNames(w).join(' ')} ${venue(w)} ${w.publication_year}`.toLowerCase().includes(f)) : [...raw];
  const by = {
    sim: (a, b) => (b.simToOrigin ?? b.graphCount ?? 0) - (a.simToOrigin ?? a.graphCount ?? 0),
    cites: (a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0),
    new: (a, b) => (b.publication_year || 0) - (a.publication_year || 0),
    old: (a, b) => (a.publication_year || 9999) - (b.publication_year || 9999),
  }[state.sort];
  return list.sort(by);
}

function renderList() {
  for (const t of ['graph', 'prior', 'derivative']) {
    const l = state.lists[t];
    $(`#count-${t}`).textContent = Array.isArray(l) && l.length ? `(${l.length})` : '';
  }
  $('#tab-help').textContent = TAB_HELP[state.tab];
  $('#sort-select').options[0].textContent = state.tab === 'graph' ? 'Most similar' : 'Most connected';
  const ol = $('#paper-list');
  const list = currentList();
  if (list === null) { ol.innerHTML = '<li class="m" style="display:block">Loading…</li>'; return; }
  if (list.error) { ol.innerHTML = `<li style="display:block"><span class="error">${esc(list.error)}</span></li>`; return; }
  if (!list.length) { ol.innerHTML = `<li class="m" style="display:block">${state.graph ? 'Nothing here yet.' : ''}</li>`; return; }
  const inGraph = new Set(state.lists.graph.map((n) => n.id));
  ol.innerHTML = list.map((w) => `
    <li data-id="${w.id}" class="${w.id === state.selected ? 'selected' : ''}" tabindex="0">
      <span class="dot" style="background:${state.color ? state.color(w.publication_year) : '#ccc'}"></span>
      <div>
        <div class="t">${esc(stripTags(w.title))}</div>
        <div class="m">${esc(shortLabel(w))} · ${w.cited_by_count ?? 0} cites${w.graphCount ? ` · <span class="badge">${state.tab === 'prior' ? 'cited by' : 'cites'} ${w.graphCount} in graph</span>` : ''}${state.tab !== 'graph' && inGraph.has(w.id) ? ' · <span class="badge">in graph</span>' : ''}${w.isOrigin ? ' · <span class="badge">origin</span>' : ''}</div>
        ${state.tab === 'graph' ? `<div class="bar" style="width:${Math.round((w.simPct ?? 0) * 100)}%"></div>` : ''}
      </div>
    </li>`).join('');
}

$('#paper-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) selectPaper(li.dataset.id);
});
$('#paper-list').addEventListener('keydown', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li && e.key === 'Enter') selectPaper(li.dataset.id);
});
$('#filter-input').addEventListener('input', (e) => { state.filter = e.target.value; renderList(); });
$('#sort-select').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  state.tab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
  renderList();
}));

function findWork(id) {
  for (const l of Object.values(state.lists)) if (Array.isArray(l)) { const w = l.find((x) => x.id === id); if (w) return w; }
  return state.graph?.corpus.get(id) || null;
}

function selectPaper(id, { fromGraph = false } = {}) {
  state.selected = id;
  if (!fromGraph) view.select(state.lists.graph.some((n) => n.id === id) ? id : null);
  document.querySelectorAll('#paper-list li').forEach((li) => li.classList.toggle('selected', li.dataset.id === id));
  document.querySelector(`#paper-list li[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  renderDetail();
}

async function renderDetail() {
  const box = $('#detail');
  const w = state.selected && findWork(state.selected);
  if (!w) { box.innerHTML = state.graph ? '<p class="empty">Click a paper in the graph or the list to see its details.</p>' : ''; return; }
  const authors = authorNames(w);
  const inGraph = state.lists.graph.some((n) => n.id === w.id);
  box.innerHTML = `
    ${w.isOrigin ? '<div class="m" style="color:var(--accent);font-weight:700">ORIGIN PAPER</div>' : ''}
    <h2>${esc(stripTags(w.title))}</h2>
    <div class="m">${esc(venue(w))}${venue(w) ? ' · ' : ''}${w.publication_year ?? ''}</div>
    <div class="authors">${esc(authors.slice(0, 8).join(', '))}${authors.length > 8 ? ` and ${authors.length - 8} more` : ''}</div>
    <div class="stats">
      <div class="stat"><b>${(w.cited_by_count ?? 0).toLocaleString()}</b><span>citations</span></div>
      <div class="stat"><b>${w.referenced_works?.length ?? 0}</b><span>references</span></div>
      ${inGraph && !w.isOrigin ? `<div class="stat"><b>${Math.round((w.simPct ?? 0) * 100)}%</b><span>similarity rank</span></div>` : ''}
    </div>
    <div class="actions">
      ${w.isOrigin ? '' : `<button class="btn accent small" id="d-build">Build graph from this paper</button>`}
      <button class="btn small" id="d-bib">Copy BibTeX</button>
      <button class="btn small" id="d-ris">Download RIS</button>
    </div>
    <div class="links">
      ${doiUrl(w) ? `<a href="${esc(doiUrl(w))}" target="_blank" rel="noopener">Publisher page</a>` : ''}
      <a href="https://openalex.org/${w.id}" target="_blank" rel="noopener">OpenAlex</a>
      <a href="https://scholar.google.com/scholar?q=${encodeURIComponent(stripTags(w.title))}" target="_blank" rel="noopener">Google Scholar</a>
    </div>
    <h3 style="font-size:14px;margin:16px 0 4px">Abstract</h3>
    <div class="abstract" id="d-abstract">${w.abstract_inverted_index ? esc(abstractFrom(w.abstract_inverted_index)) : '<span class="m">Loading…</span>'}</div>`;
  $('#d-build')?.addEventListener('click', () => go(w.id));
  $('#d-bib').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(toBibTeX([w])); toast('BibTeX copied'); }
    catch { download(`${w.id}.bib`, toBibTeX([w])); }
  });
  $('#d-ris').addEventListener('click', () => download(`${w.id}.ris`, toRIS([w]), 'application/x-research-info-systems'));
  if (!w.abstract_inverted_index) {
    try {
      const full = await getWork(w.id); // single lookups are free
      if (state.selected !== w.id) return;
      w.abstract_inverted_index = full.abstract_inverted_index || null;
      $('#d-abstract').innerHTML = w.abstract_inverted_index ? esc(abstractFrom(w.abstract_inverted_index)) : '<span class="m">No abstract available in OpenAlex.</span>';
    } catch { $('#d-abstract').innerHTML = '<span class="m">Abstract unavailable.</span>'; }
  }
}

// ---- exports ----
document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => {
  const list = currentList();
  if (!Array.isArray(list) || !list.length) return toast('Nothing to export yet');
  const base = `rhizome-${state.origin.id}-${state.tab}`;
  const kind = b.dataset.export;
  if (kind === 'bib') download(`${base}.bib`, toBibTeX(list), 'application/x-bibtex');
  if (kind === 'ris') download(`${base}.ris`, toRIS(list), 'application/x-research-info-systems');
  if (kind === 'csv') download(`${base}.csv`, toCSV(list), 'text/csv');
}));
$('#zoom-in').addEventListener('click', () => view.zoomBy(1.3));
$('#zoom-out').addEventListener('click', () => view.zoomBy(1 / 1.3));
$('#zoom-fit').addEventListener('click', () => view.fit());
$('#save-svg').addEventListener('click', () => state.graph && download(`rhizome-${state.origin.id}.svg`, view.exportSVG(), 'image/svg+xml'));

// ---- settings ----
$('#settings-btn').addEventListener('click', () => {
  $('#opt-size').value = String(prefs.size);
  $('#opt-key').value = settings.apiKey;
  $('#usage-line').textContent = usage.calls ? `This session: ${usage.calls} OpenAlex calls, about $${usage.costUsd.toFixed(4)} of the free daily budget.` : '';
  $('#settings').showModal();
});
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  const newSize = Number($('#opt-size').value);
  settings.apiKey = $('#opt-key').value.trim();
  store.set('apiKey', settings.apiKey);
  store.set('size', newSize);
  if (newSize !== prefs.size) {
    prefs.size = newSize;
    if (state.origin) { state.graph = null; loadGraph(state.origin.id); }
  }
});

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

route();
