// Builds a similarity graph around one origin paper.
//
// Similarity between two papers combines two classic bibliometric signals:
//   • bibliographic coupling: how many references they share
//   • co-citation: how many papers (in the collected corpus) cite both
// Each is cosine-normalised (Salton's index) so that huge reference lists or
// highly cited classics do not swamp the score. Papers end up linked and close
// together when they share many references or are often cited together, even
// if neither cites the other.

import { getWorksByIds, getCitingWorks } from './openalex.js';

const REF_LIMIT = 300;      // origin references to fetch
const CITER_PAGES = 2;      // up to 200 papers citing the origin
const EXPAND_LIMIT = 100;   // extra frequently co-cited papers
const EDGES_PER_NODE = 5;
const SIBLING_SEED_REFS = 50; // most specific origin references used to find siblings
const SIBLING_PAGES = 3;      // up to 300 papers citing those references

export async function buildGraph(origin, { size = 40, onProgress = () => {} } = {}) {
  const docs = new Map(); // id -> work
  const add = (w) => { if (w && w.id && !docs.has(w.id)) docs.set(w.id, w); };
  add(origin);

  onProgress('Fetching references and citing papers…');
  const [refs, citers, related] = await Promise.all([
    getWorksByIds(origin.referenced_works.slice(0, REF_LIMIT)),
    getCitingWorks([origin.id], { pages: CITER_PAGES }),
    origin.related_works?.length ? getWorksByIds(origin.related_works) : [],
  ]);
  [...refs, ...citers, ...related].forEach(add);

  // Siblings: papers that cite the origin's most specific references (the
  // least-cited ones) are likely to share many references with the origin,
  // even if they never cite it. Highly cited classics are skipped because
  // almost everything in a field cites them.
  const specificRefs = origin.referenced_works.map((id) => docs.get(id)).filter(Boolean)
    .sort((a, b) => (a.cited_by_count || 0) - (b.cited_by_count || 0))
    .slice(0, SIBLING_SEED_REFS).map((w) => w.id);
  if (specificRefs.length) {
    onProgress('Finding papers that share its references…');
    (await getCitingWorks(specificRefs, { pages: SIBLING_PAGES })).forEach(add);
  }

  // Expand the pool with papers that the neighbourhood cites repeatedly:
  // they are strongly co-cited with the origin's field.
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

  const candidates = [...docs.values()].filter((d) => d.id !== origin.id)
    .map((d) => ({ d, s: sim(origin.id, d.id) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.d.cited_by_count || 0) - (a.d.cited_by_count || 0))
    .slice(0, size - 1);

  const nodes = [{ ...origin, simToOrigin: 1, isOrigin: true }, ...candidates.map(({ d, s }) => ({ ...d, simToOrigin: s }))];

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

  // normalise similarity to origin to 0..1 for display (origin excluded)
  const maxS = Math.max(...candidates.map((c) => c.s), 1e-9);
  nodes.forEach((n) => { if (!n.isOrigin) n.simPct = n.simToOrigin / maxS; else n.simPct = 1; });

  return { nodes, links, corpus: docs, corpusSize: docs.size };
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
