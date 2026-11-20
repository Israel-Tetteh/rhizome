# Rhizome

**A free, open-source map of the literature around any paper.**

Give Rhizome one paper (a DOI, a title, an OpenAlex or Semantic Scholar id, or a link) and it draws an
interactive graph of the papers most closely related to it. Similar papers sit close together and are
linked, even when they never cite each other. No account, no subscription, no tracking.

**Use it:** https://israel-tetteh.github.io/rhizome/

## What you get

- **Similarity graph.** About 40 related papers (25 to 80, set in Settings). Node size shows citations,
  colour shows publication year, and line thickness shows how strongly two papers are related.
- **Prior works.** Papers cited by many papers in the graph, usually the foundations of the field.
- **Derivative works.** Papers that cite many papers in the graph, usually recent reviews and follow-up work.
- **Paper details.** Authors, venue, citation count and abstract, with links to the publisher,
  OpenAlex and Google Scholar. Double-click any node (or press *Build graph from this paper*) to re-centre.
- **Export for your reference manager.** Any list exports to **BibTeX**, **RIS** (Zotero, Mendeley,
  EndNote) or **CSV**. In Zotero use *File → Import…* and pick the downloaded file. The graph itself
  downloads as SVG.
- **Shareable links.** Every graph has its own URL, e.g.
  `https://israel-tetteh.github.io/rhizome/#/W4226146299`.

## How similarity is computed

Rhizome collects a neighbourhood of a few hundred papers around the origin paper:

1. its references and the papers that cite it,
2. OpenAlex's related works,
3. papers that cite the origin's most specific (least-cited) references, which finds "siblings"
   that work on the same problem without citing the origin,
4. papers the neighbourhood cites repeatedly.

For any two papers A and B it then combines two classic bibliometric measures:

- **Bibliographic coupling:** the number of references A and B share,
- **Co-citation:** the number of papers in the neighbourhood that cite both A and B,

each normalised by the geometric mean of the list sizes (Salton's cosine), plus a small bonus when
one cites the other. The papers most similar to the origin become the graph, and each keeps links to
its five most similar neighbours. A force-directed layout then pulls similar papers together.

Building one graph takes about 12 OpenAlex requests and a few seconds.

## Data and cost

All data comes from [OpenAlex](https://openalex.org), an open index of 250M+ scholarly works released
under CC0. OpenAlex is free; without an API key each network gets a small daily budget, which covers
dozens of graphs a day. For heavy use, get a [free OpenAlex API key](https://openalex.org/settings/api)
and paste it into Rhizome's Settings. The key is kept only in your browser.

Coverage follows OpenAlex: very new papers, or papers whose references OpenAlex has not indexed, give
smaller graphs.

## Run it yourself

Rhizome is a static site: plain HTML, CSS and JavaScript with [d3](https://d3js.org) loaded from a CDN.
There is no build step and no server.

```bash
git clone https://github.com/Israel-Tetteh/rhizome.git
cd rhizome
python3 -m http.server 8000   # then open http://localhost:8000
npm test                      # unit tests for the graph builder and exports (Node 18+)
```

To host your own copy, fork the repo and turn on GitHub Pages (Settings → Pages → Deploy from branch → `main` / root).

## Project layout

| File | What it does |
| --- | --- |
| `index.html`, `css/style.css` | Page and styles (light and dark) |
| `js/openalex.js` | Small OpenAlex API client with caching and retries |
| `js/graph-builder.js` | Neighbourhood collection, similarity, prior and derivative works |
| `js/graph-view.js` | Interactive d3 force layout |
| `js/export.js` | BibTeX, RIS and CSV export |
| `js/app.js` | Search, routing, lists and the detail panel |
| `tests/` | Node tests with a mocked API |

## Contributing

Issues and pull requests are welcome. Ideas on the list: multi-paper origins, saving graphs,
a timeline view, and an R/Shiny companion.

## Licence

MIT, see [LICENSE](LICENSE). Data from OpenAlex is CC0. Please cite OpenAlex if you use Rhizome in published work:
Priem, J., Piwowar, H., & Orr, R. (2022). OpenAlex: A fully-open index of scholarly works, authors, venues,
institutions, and concepts. arXiv:2205.01833.
