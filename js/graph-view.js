// Interactive force-directed view of the similarity graph (d3, SVG).
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';
import { shortLabel } from './openalex.js';

export function yearScale(nodes) {
  const years = nodes.map((n) => n.publication_year).filter(Boolean);
  const lo = Math.min(...years), hi = Math.max(...years);
  const interp = (t) => d3.interpolateRgbBasis(['#e8dcc0', '#9cc59a', '#3f8f7a', '#1d4e63'])(t);
  const f = (y) => (y ? interp(hi === lo ? 1 : (y - lo) / (hi - lo)) : '#bbb');
  f.lo = lo; f.hi = hi; f.interp = interp;
  return f;
}

export function createGraphView(container, { onSelect, onOpen }) {
  const svg = d3.select(container).append('svg').attr('class', 'graph-svg').attr('role', 'img')
    .attr('aria-label', 'Graph of related papers');
  const root = svg.append('g');
  const linkG = root.append('g').attr('class', 'links');
  const nodeG = root.append('g').attr('class', 'nodes');
  const labelG = root.append('g').attr('class', 'labels');
  let sim, nodeSel, linkSel, labelSel, data, selectedId = null, neighbours = new Map();

  const zoom = d3.zoom().scaleExtent([0.2, 6]).on('zoom', (e) => {
    root.attr('transform', e.transform);
    labelG.attr('data-zoom', e.transform.k > 1.4 ? 'near' : 'far');
  });
  svg.call(zoom).on('dblclick.zoom', null);
  svg.on('click', (e) => { if (e.target === svg.node()) select(null); });

  function render(graph) {
    data = graph;
    const { width, height } = container.getBoundingClientRect();
    svg.attr('viewBox', [-width / 2, -height / 2, width, height]);
    const color = yearScale(graph.nodes);
    const maxC = d3.max(graph.nodes, (n) => n.cited_by_count || 0) || 1;
    const radius = d3.scaleSqrt().domain([0, maxC]).range([5, 26]);
    const maxW = d3.max(graph.links, (l) => l.weight) || 1;

    neighbours = new Map(graph.nodes.map((n) => [n.id, new Set()]));
    graph.links.forEach((l) => {
      const s = l.source.id || l.source, t = l.target.id || l.target;
      neighbours.get(s)?.add(t); neighbours.get(t)?.add(s);
    });

    graph.nodes.forEach((n) => { n.r = radius(n.cited_by_count || 0); });
    const origin = graph.nodes.find((n) => n.isOrigin);
    if (origin) { origin.fx = 0; origin.fy = 0; }

    linkSel = linkG.selectAll('line').data(graph.links).join('line')
      .attr('stroke-width', (l) => 0.6 + 2.4 * (l.weight / maxW))
      .attr('stroke-opacity', (l) => 0.15 + 0.5 * (l.weight / maxW));

    nodeSel = nodeG.selectAll('circle').data(graph.nodes, (n) => n.id).join('circle')
      .attr('r', (n) => n.r)
      .attr('fill', (n) => color(n.publication_year))
      .attr('class', (n) => (n.isOrigin ? 'node origin' : 'node'))
      .attr('tabindex', 0)
      .on('click', (e, n) => { e.stopPropagation(); select(n.id); onSelect?.(n.id); })
      .on('dblclick', (e, n) => { e.stopPropagation(); onOpen?.(n.id); })
      .on('keydown', (e, n) => { if (e.key === 'Enter') { select(n.id); onSelect?.(n.id); } })
      .on('mouseenter', (e, n) => hover(n.id))
      .on('mouseleave', () => hover(null))
      .call(d3.drag()
        .on('start', (e, n) => { if (!e.active) sim.alphaTarget(0.2).restart(); n.fx = n.x; n.fy = n.y; })
        .on('drag', (e, n) => { n.fx = e.x; n.fy = e.y; })
        .on('end', (e, n) => { if (!e.active) sim.alphaTarget(0); if (!n.isOrigin) { n.fx = null; n.fy = null; } }));
    nodeSel.selectAll('title').data((n) => [n]).join('title').text((n) => `${n.title}\n${shortLabel(n)} · ${n.cited_by_count ?? 0} citations`);

    labelSel = labelG.selectAll('text').data(graph.nodes, (n) => n.id).join('text')
      .attr('class', (n) => (n.isOrigin ? 'label origin' : 'label'))
      .text((n) => shortLabel(n).replace(' et al.', ''));

    sim?.stop();
    sim = d3.forceSimulation(graph.nodes)
      .force('link', d3.forceLink(graph.links).id((n) => n.id)
        .distance((l) => 40 + 160 * (1 - l.weight / maxW))
        .strength((l) => 0.15 + 0.6 * (l.weight / maxW)))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('collide', d3.forceCollide((n) => n.r + 4))
      .force('x', d3.forceX().strength(0.04))
      .force('y', d3.forceY().strength(0.04))
      .on('tick', tick);
    svg.call(zoom.transform, d3.zoomIdentity);
    sim.on('end', () => fit());
    select(selectedId && neighbours.has(selectedId) ? selectedId : null);
    return color;
  }

  function tick() {
    linkSel.attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y)
      .attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
    nodeSel.attr('cx', (n) => n.x).attr('cy', (n) => n.y);
    labelSel.attr('x', (n) => n.x).attr('y', (n) => n.y + n.r + 11);
  }

  function emphasise(id) {
    if (!nodeSel) return;
    const near = id ? neighbours.get(id) : null;
    const on = (nid) => !id || nid === id || near?.has(nid);
    nodeSel.classed('dim', (n) => !on(n.id)).classed('selected', (n) => n.id === selectedId);
    labelSel.classed('dim', (n) => !on(n.id)).classed('show', (n) => !!id && on(n.id));
    linkSel.classed('dim', (l) => id && l.source.id !== id && l.target.id !== id)
      .classed('hot', (l) => id && (l.source.id === id || l.target.id === id));
  }
  function hover(id) { emphasise(id || selectedId); }
  function select(id) { selectedId = id; emphasise(id); }

  function fit(pad = 40) {
    if (!data?.nodes.length) return;
    const { width, height } = container.getBoundingClientRect();
    const xs = data.nodes.map((n) => n.x), ys = data.nodes.map((n) => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs) - 30, Math.max(...xs) + 30, Math.min(...ys) - 30, Math.max(...ys) + 40];
    const k = Math.min(2, 0.95 / Math.max((x1 - x0) / (width - pad), (y1 - y0) / (height - pad)));
    const t = d3.zoomIdentity.scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    svg.transition().duration(500).call(zoom.transform, t);
  }

  const zoomBy = (f) => svg.transition().duration(250).call(zoom.scaleBy, f);

  function exportSVG() {
    const clone = svg.node().cloneNode(true);
    const cs = getComputedStyle(document.documentElement);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.insertAdjacentHTML('afterbegin', `<style>
      line{stroke:${cs.getPropertyValue('--edge')}} circle{stroke:${cs.getPropertyValue('--node-stroke')};stroke-width:1}
      circle.origin{stroke:${cs.getPropertyValue('--accent')};stroke-width:3}
      text{font:10px sans-serif;fill:${cs.getPropertyValue('--text')};text-anchor:middle}</style>
      <rect x="-50%" y="-50%" width="200%" height="200%" fill="${cs.getPropertyValue('--surface')}"/>`);
    return new XMLSerializer().serializeToString(clone);
  }

  new ResizeObserver(() => {
    const { width, height } = container.getBoundingClientRect();
    if (width && height) svg.attr('viewBox', [-width / 2, -height / 2, width, height]);
  }).observe(container);

  return { render, select, fit, zoomBy, exportSVG };
}
