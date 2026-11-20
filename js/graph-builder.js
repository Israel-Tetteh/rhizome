// Builds a similarity graph around one or more origin papers.
//
// Similarity between two papers combines two classic bibliometric signals:
//   • bibliographic coupling: how many references they share
//   • co-citation: how many papers (in the collected corpus) cite both
// Each is cosine-normalised (Salton's index) so that huge reference lists or
// highly cited classics do not swamp the score. Papers end up linked and close
// together when they share many references or are often cited together, even
// if neither cites the other.

import { getWorksByIds, getCitingWorks } from './openalex.js?v=20261120b';

const REF_LIMIT = 300;      // origin references to fetch
const CITER_PAGES = 2;      // up to 200 papers citing the origin
const EXPAND_LIMIT = 100;   // extra frequently co-cited papers
const EDGES_PER_NODE = 5;
const SIBLING_SEED_REFS = 50; // most specific origin references used to find siblings
const SIBLING_PAGES = 3;      // up to 300 papers citing those references

/**
 * Build a graph around one or more origin papers.
 * @param {object|object[]} originOrOrigins  full OpenAlex work(s), with referenced_works
 * @param {{size?:number, exclude?:Set<string>, onProgress?:Function}} opts
 */
export async function buildGraph(originOrOrigins, { size = 40, exclude = new Set(), onProgress = () => {} } = {}) {
  const origins = Array.isArray(originOrOrigins) ? originOrOrigins : [originOrOrigins];
  const originIds = new Set(origins.map((o) => o.id));
  const docs = new Map(); // id -> work
  const add = (w) => { if (w && w.id && !docs.has(w.id)) docs.set(w.id, w); };
  origins.forEach(add);
  const allRefs = [...new Set(origins.flatMap((o) => o.referenced_works))];
  const refLimit = origins.length > 1 ? REF_LIMIT + 100 : REF_LIMIT;

  onProgress(origins.length > 1 ? `Fetching references and citing papers of ${origins.length} papers…` : 'Fetching references and citing papers…');
  const related = [...new Set(origins.flatMap((o) => o.related_works || []))].slice(0, 40);
  const [refs, citers, rel] = await Promise.all([
    getWorksByIds(allRefs.slice(0, refLimit)),
    getCitingWorks([...originIds], { pages: CITER_PAGES }),
    related.length ? getWorksByIds(related) : [],
  ]);
  [...refs, ...citers, ...rel].forEach(add);

  // Siblings: papers that cite the origins' most specific references (the
  // least-cited ones) are likely to share many references with them, even if
  // they never cite them. Highly cited classics are skipped because almost
  // everything in a field cites them.
  const specificRefs = allRefs.map((id) => docs.get(id)).filter(Boolean)
    .sort((a, b) => (a.cited_by_count || 0) - (b.cited_by_count || 0))
    .slice(0, SIBLING_SEED_REFS).map((w) => w.id);
  if (specificRefs.length) {
    onProgress('Finding papers that share their references…');
    (await getCitingWorks(specificRefs, { pages: SIBLING_PAGES })).forEach(add);
  }

  // Expand the pool with papers that the neighbourhood cites repeatedly:
  // they are strongly co-cited with the origins' field.
  const freq = new Map();
  for (const d of docs.values()) {
    for (const r of d.referenced_works) if (!docs.has(r)) freq.set(r, (freq.get(r) || 0) + 1);
  }
  const extra = [...freq.entries()].filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, EXPAND_LIMIT).map(([id]) => id);
  if (extra.length) {
    onProgress('Expanding with co-cited papers…');
    (await getWorksByIds(extra)).forEach(add);
  }

  onProgress('Computing similarity…');
  return assembleGraph(origins, docs, { size, exclude });
}

/** Score, select and link papers from an already collected corpus (no network). */
export function assembleGraph(origins, docs, { size = 40, exclude = new Set() } = {}) {
  const originIds = new Set(origins.map((o) => o.id));
  const refSets = new Map();
  const citedBy = new Map(); // id -> Set of corpus docs citing it
  for (const d of docs.values()) {
    const s = new Set(d.referenced_works);
    refSets.set(d.id, s);
    for (const r of s) {
      if (!citedBy.has(r)) citedBy.set(r, new Set());
      citedBy.get(r).add(d.id);
    }
  }

  const sim = makeSimilarity(refSets, citedBy);
  // With several origins, a paper related to many of them scores higher.
  const score = (id) => origins.reduce((t, o) => t + sim(o.id, id), 0);

  const candidates = [...docs.values()].filter((d) => !originIds.has(d.id) && !exclude.has(d.id))
    .map((d) => ({ d, s: score(d.id) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.d.cited_by_count || 0) - (a.d.cited_by_count || 0))
    .slice(0, Math.max(size - origins.length, 5));

  const nodes = [
    ...origins.map((o) => ({ ...o, simToOrigin: Infinity, isOrigin: true })),
    ...candidates.map(({ d, s }) => ({ ...d, simToOrigin: s })),
  ];

  // Pairwise similarities among the chosen nodes; keep each node's strongest links.
  const pairs = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const w = sim(nodes[i].id, nodes[j].id);
      if (w > 0) pairs.push({ i, j, w });
    }
  }
  const byNode = nodes.map(() => []);
  for (const p of pairs) { byNode[p.i].push(p); byNode[p.j].push(p); }
  const keep = new Set();
  byNode.forEach((list) => list.sort((a, b) => b.w - a.w).slice(0, EDGES_PER_NODE).forEach((p) => keep.add(p)));
  const links = [...keep].map((p) => ({ source: nodes[p.i].id, target: nodes[p.j].id, weight: p.w }));

  // normalise similarity to 0..1 for display; count connections for the map view
  const maxS = Math.max(...candidates.map((c) => c.s), 1e-9);
  const degree = new Map();
  links.forEach((l) => { degree.set(l.source, (degree.get(l.source) || 0) + 1); degree.set(l.target, (degree.get(l.target) || 0) + 1); });
  nodes.forEach((n) => {
    n.simPct = n.isOrigin ? 1 : n.simToOrigin / maxS;
    n.degree = degree.get(n.id) || 0;
  });

  // `pool` stays exactly as collected, so rebuilding (e.g. after hiding a paper) is repeatable;
  // `corpus` also gathers papers fetched later for the prior/derivative lists.
  return { nodes, links, pool: docs, corpus: new Map(docs), corpusSize: docs.size, origins };
}

function makeSimilarity(refSets, citedBy) {
  const inter = (a, b) => {
    if (!a || !b || !a.size || !b.size) return 0;
    const [small, big] = a.size < b.size ? [a, b] : [b, a];
    let n = 0;
    for (const x of small) if (big.has(x)) n++;
    return n;
  };
  return (a, b) => {
    const ra = refSets.get(a), rb = refSets.get(b);
    const ca = citedBy.get(a), cb = citedBy.get(b);
    // "+ 1" shrinks scores built on very little evidence (e.g. two papers each
    // cited once, by the same paper) so they do not look like perfect matches.
    const coupling = ra && rb && ra.size && rb.size ? inter(ra, rb) / (Math.sqrt(ra.size * rb.size) + 1) : 0;
    const cocite = ca && cb ? inter(ca, cb) / (Math.sqrt(ca.size * cb.size) + 1) : 0;
    const direct = (ra && ra.has(b)) || (rb && rb.has(a)) ? 0.05 : 0;
    return coupling + cocite + direct;
  };
}

/** Papers most often cited by the graph's papers: likely the field's foundations. */
export async function priorWorks(graph, { limit = 30 } = {}) {
  const counts = new Map();
  for (const n of graph.nodes) for (const r of n.referenced_works) counts.set(r, (counts.get(r) || 0) + 1);
  const top = [...counts.entries()].filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, limit * 2);
  const missing = top.map(([id]) => id).filter((id) => !graph.corpus.has(id));
  if (missing.length) (await getWorksByIds(missing)).forEach((w) => graph.corpus.set(w.id, w));
  return top.map(([id, c]) => ({ ...graph.corpus.get(id), graphCount: c }))
    .filter((w) => w.id)
    .sort((a, b) => b.graphCount - a.graphCount || (b.cited_by_count || 0) - (a.cited_by_count || 0))
    .slice(0, limit);
}

/** Papers that cite many of the graph's papers: likely reviews or later work building on the field. */
export async function derivativeWorks(graph, { limit = 30 } = {}) {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const citers = await getCitingWorks([...ids], { pages: 2 });
  return citers.map((w) => ({ ...w, graphCount: w.referenced_works.filter((r) => ids.has(r)).length }))
    .filter((w) => w.graphCount >= 2)
    .sort((a, b) => b.graphCount - a.graphCount || (b.publication_year || 0) - (a.publication_year || 0))
    .slice(0, limit);
}
