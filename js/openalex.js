// Thin client for the free OpenAlex API (https://openalex.org).
// All data is CC0. Without a key each IP gets a small free daily budget;
// a free key (openalex.org/settings/api) raises it tenfold.

const BASE = 'https://api.openalex.org';

export const WORK_FIELDS = [
  'id', 'doi', 'title', 'display_name', 'publication_year', 'publication_date',
  'cited_by_count', 'referenced_works', 'authorships', 'primary_location',
  'biblio', 'type', 'ids', 'language', 'open_access', 'primary_topic',
].join(',');

export const settings = { apiKey: '' };
export const usage = { calls: 0, costUsd: 0 };

const cache = new Map();

export class ApiError extends Error {
  constructor(status, message) {
    super(message || `OpenAlex request failed (${status})`);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  if (settings.apiKey) url.searchParams.set('api_key', settings.apiKey);
  const key = url.toString();
  if (cache.has(key)) return cache.get(key);

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      if (attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
      throw new ApiError(0, 'Could not reach OpenAlex. Check your connection.');
    }
    if (res.status === 429 && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
    if (!res.ok) {
      let msg = '';
      try { const j = await res.json(); msg = j.message || j.error || ''; } catch { /* ignore */ }
      if (res.status === 404) msg = 'Paper not found in OpenAlex.';
      if (res.status === 429) msg = 'The free daily OpenAlex budget for your network is used up. Add a free API key in Settings, or try again tomorrow.';
      throw new ApiError(res.status, msg);
    }
    const json = await res.json();
    usage.calls++;
    if (json?.meta?.cost_usd) usage.costUsd += json.meta.cost_usd;
    cache.set(key, json);
    return json;
  }
}

export const shortId = (id) => (id ? String(id).replace(/^https?:\/\/openalex\.org\//i, '') : id);

/** Fetch one work by OpenAlex id, "doi:…", "pmid:…" etc. Single lookups are free. */
export async function getWork(ref) {
  const w = await get(`/works/${encodeURI(ref)}`, { select: WORK_FIELDS + ',related_works,abstract_inverted_index' });
  return normalize(w);
}

/** Fetch many works by OpenAlex id, 100 per call. */
export async function getWorksByIds(ids, { select = WORK_FIELDS } = {}) {
  const unique = [...new Set(ids.map(shortId))].filter(Boolean);
  const chunks = [];
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));
  const pages = await Promise.all(chunks.map((chunk) =>
    get('/works', { filter: `ids.openalex:${chunk.join('|')}`, per_page: 100, select })));
  return pages.flatMap((j) => j.results.map(normalize));
}

/** Works that cite any of `ids`, most cited first. Pages are fetched in parallel. */
export async function getCitingWorks(ids, { pages = 2, select = WORK_FIELDS } = {}) {
  const unique = [...new Set(ids.map(shortId))].slice(0, 100);
  const params = (page) => ({ filter: `cites:${unique.join('|')}`, sort: 'cited_by_count:desc', per_page: 100, page, select });
  const first = await get('/works', params(1));
  const total = Math.min(pages, Math.ceil((first.meta?.count || 0) / 100));
  const rest = await Promise.all(Array.from({ length: Math.max(0, total - 1) }, (_, i) => get('/works', params(i + 2))));
  return [first, ...rest].flatMap((j) => j.results.map(normalize));
}

export async function searchWorks(query, n = 8) {
  const j = await get('/works', {
    search: query, per_page: n,
    select: 'id,doi,title,display_name,publication_year,cited_by_count,authorships,primary_location,primary_topic',
  });
  return j.results.map(normalize);
}

/** Resolve a Semantic Scholar paper id / arXiv id to a DOI or title via the free S2 API. */
export async function resolveViaSemanticScholar(s2ref) {
  let res;
  try {
    res = await fetch(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2ref)}?fields=title,externalIds`);
  } catch {
    throw new ApiError(0, 'Semantic Scholar is not answering right now (it limits free use). Paste the paper\'s DOI or title instead.');
  }
  if (!res.ok) throw new ApiError(res.status, 'Semantic Scholar could not find that paper id.');
  const j = await res.json();
  return { doi: j.externalIds?.DOI || null, title: j.title || null };
}

function normalize(w) {
  if (!w) return w;
  return {
    ...w,
    id: shortId(w.id),
    title: w.title || w.display_name || '(untitled)',
    referenced_works: (w.referenced_works || []).map(shortId),
    related_works: (w.related_works || []).map(shortId),
  };
}

export function abstractFrom(inv) {
  if (!inv) return '';
  const words = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  return words.filter(Boolean).join(' ');
}

export const authorNames = (w) => (w.authorships || []).map((a) => a.author?.display_name || a.raw_author_name).filter(Boolean);

export function firstAuthorLast(w) {
  const n = authorNames(w)[0];
  if (!n) return 'Anon.';
  const parts = n.trim().split(/\s+/);
  return parts[parts.length - 1];
}

export function shortLabel(w) {
  const n = authorNames(w).length;
  return `${firstAuthorLast(w)}${n > 1 ? ' et al.' : ''}, ${w.publication_year ?? 'n.d.'}`;
}

export const venue = (w) => w.primary_location?.source?.display_name || '';
export const doiUrl = (w) => (w.doi ? (w.doi.startsWith('http') ? w.doi : `https://doi.org/${w.doi}`) : null);
export const bareDoi = (w) => (w.doi ? w.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : '');
