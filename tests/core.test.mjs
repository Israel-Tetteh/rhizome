// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, priorWorks, derivativeWorks } from '../js/graph-builder.js';
import { toBibTeX, toRIS } from '../js/export.js';

// A tiny synthetic citation network served through a fake fetch.
const W = (id, year, refs, cites = 10) => ({
  id: `https://openalex.org/${id}`, title: `Paper ${id}`, publication_year: year, cited_by_count: cites,
  referenced_works: refs.map((r) => `https://openalex.org/${r}`),
  authorships: [{ author: { display_name: 'Ada Lovelace' } }, { author: { display_name: 'Kwame Mensah' } }],
  primary_location: { source: { display_name: 'Plant Journal' } }, biblio: { volume: '3', issue: '1', first_page: '10', last_page: '20' },
  type: 'article', doi: `https://doi.org/10.1/${id.toLowerCase()}`,
});
const corpus = [
  W('W1', 2020, ['W10', 'W11', 'W12']),            // origin
  W('W10', 2010, ['W20']), W('W11', 2012, ['W20']), W('W12', 2014, ['W21']),
  W('W2', 2021, ['W1', 'W10', 'W11']),              // cites origin, shares 2 refs
  W('W3', 2022, ['W1', 'W10', 'W11', 'W12', 'W2']), // cites origin, shares 3 refs
  W('W4', 2019, ['W10', 'W11', 'W12']),             // sibling: same refs, no direct link
  W('W20', 2000, []), W('W21', 2001, []),
  W('W99', 2023, ['W2', 'W3', 'W4']),              // derivative work
];
const byId = new Map(corpus.map((w) => [w.id.split('/').pop(), w]));
const citers = (ids) => corpus.filter((w) => w.referenced_works.some((r) => ids.includes(r.split('/').pop())));

globalThis.fetch = async (url) => {
  const u = new URL(url);
  const f = u.searchParams.get('filter') || '';
  let results = [];
  if (f.startsWith('ids.openalex:')) results = f.slice(13).split('|').map((id) => byId.get(id)).filter(Boolean);
  else if (f.startsWith('cites:')) results = citers(f.slice(6).split('|'));
  return { ok: true, status: 200, json: async () => ({ meta: { cost_usd: 0.0001, count: results.length }, results }) };
};

const origin = { ...byId.get('W1'), id: 'W1', referenced_works: ['W10', 'W11', 'W12'], related_works: [] };

test('graph ranks the reference-sharing sibling and citers as most similar', async () => {
  const g = await buildGraph(origin, { size: 6 });
  const ids = g.nodes.map((n) => n.id);
  assert.equal(ids[0], 'W1');
  assert.ok(ids.includes('W4'), 'bibliographic coupling finds W4 even though it never cites W1');
  assert.ok(ids.includes('W3') && ids.includes('W2'));
  assert.ok(g.links.length > 0);
  const w4 = g.nodes.find((n) => n.id === 'W4');
  assert.ok(w4.simToOrigin > 0.7, 'identical reference lists give a high coupling score');
});

test('prior and derivative works', async () => {
  const g = await buildGraph(origin, { size: 6 });
  const prior = await priorWorks(g);
  assert.ok(prior.some((p) => p.id === 'W10' && p.graphCount >= 3));
  const deriv = await derivativeWorks(g);
  assert.ok(deriv.some((d) => d.id === 'W99'));
});

test('BibTeX and RIS export', () => {
  const w = { ...byId.get('W2'), id: 'W2' };
  const bib = toBibTeX([w, w]);
  assert.match(bib, /@article\{lovelace2021paper,/);
  assert.match(bib, /@article\{lovelace2021paperb,/);
  assert.match(bib, /author = \{Lovelace, Ada and Mensah, Kwame\}/);
  assert.match(bib, /pages = \{10--20\}/);
  const ris = toRIS([w]);
  assert.match(ris, /^TY {2}- JOUR/m);
  assert.match(ris, /^AU {2}- Mensah, Kwame/m);
  assert.match(ris, /^DO {2}- 10\.1\/w2/m);
  assert.match(ris, /^ER {2}- $/m);
});
