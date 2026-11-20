// Interactive force-directed view of the similarity graph (d3, SVG).
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';
import { shortLabel } from './openalex.js';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ramp = () => d3.interpolateRgbBasis([0, 1, 2, 3].map((i) => cssVar(`--ramp-${i}`) || '#888'));
const catColors = () => Array.from({ length: 8 }, (_, i) => cssVar(`--cat-${i + 1}`) || '#888');
export const topicOf = (w) => w.primary_topic?.display_name || null;

/**
 * Builds the colour function for a colour mode. Returns
 * { color(work), legend: {type:'ramp'|'cats', ...} }.
 */
export function makeColorer(nodes, mode) {
  const none = cssVar('--muted') || '#999';
  if (mode === 'topic') {
    const counts = d3.rollup(nodes.filter(topicOf), (v) => v.length, topicOf);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([t]) => t);
    const pal = catColors();
    const other = pal[7];
    const color = (w) => { const t = topicOf(w); if (!t) return none; const i = top.indexOf(t); return i < 0 ? other : pal[i]; };
    const cats = top.map((t, i) => ({ label: t, color: pal[i], count: counts.get(t) }));
    const otherCount = nodes.filter((n) => topicOf(n) && !top.includes(topicOf(n))).length;
    if (otherCount) cats.push({ label: 'Other topics', color: other, count: otherCount, other: true });
    return { color, legend: { type: 'cats', title: 'Colour: research topic', cats, top } };
  }
  const interp = ramp();
  if (mode === 'citations') {
    const max = d3.max(nodes, (n) => n.cited_by_count || 0) || 1;
    const s = d3.scaleLog().domain([1, max + 1]).range([0, 1]).clamp(true);
    return { color: (w) => interp(s((w.cited_by_count || 0) + 1)), legend: { type: 'ramp', title: 'Colour: citations', lo: '0', hi: max.toLocaleString(), interp } };
  }
  const years = nodes.map((n) => n.publication_year).filter(Boolean);
  const lo = d3.min(years), hi = d3.max(years);
  const color = (w) => (w.publication_year ? interp(hi === lo ? 1 : (w.publication_year - lo) / (hi - lo)) : none);
  return { color, legend: { type: 'ramp', title: 'Colour: year', lo, hi, interp } };
}

export function createGraphView(container, { onSelect, onOpen }) {
  const svg = d3.select(container).append('svg').attr('class', 'graph-svg').attr('role', 'img')
    .attr('aria-label', 'Graph of related papers');
  const root = svg.append('g');
  const axisG = root.append('g').attr('class', 'time-axis');
  const linkG = root.append('g').attr('class', 'links');
  const nodeG = root.append('g').attr('class', 'nodes');
  const labelG = root.append('g').attr('class', 'labels');
  let sim, nodeSel, linkSel, labelSel, data, selectedId = null, hoverId = null, highlightSet = null;
  let neighbours = new Map();
  let colorMode = 'year', layout = 'similarity', showLabels = true, colorer = null;

  const zoom = d3.zoom().scaleExtent([0.15, 8]).on('zoom', (e) => root.attr('transform', e.transform));
  svg.call(zoom).on('dblclick.zoom', null);
  svg.on('click', (e) => { if (e.target === svg.node()) { select(null); onSelect?.(null); } });

  function size() {
    const { width, height } = container.getBoundingClientRect();
    return { width: width || 600, height: height || 400 };
  }

  function render(graph) {
    data = graph;
    const { width, height } = size();
    svg.attr('viewBox', [-width / 2, -height / 2, width, height]);
    const maxC = d3.max(graph.nodes, (n) => n.cited_by_count || 0) || 1;
    const radius = d3.scaleSqrt().domain([0, maxC]).range([5, 26]);
    const maxW = d3.max(graph.links, (l) => l.weight) || 1;

    neighbours = new Map(graph.nodes.map((n) => [n.id, new Set()]));
    graph.links.forEach((l) => {
      const s = l.source.id || l.source, t = l.target.id || l.target;
      neighbours.get(s)?.add(t); neighbours.get(t)?.add(s);
    });
    graph.nodes.forEach((n) => { n.r = radius(n.cited_by_count || 0); });

    linkSel = linkG.selectAll('line').data(graph.links).join('line')
      .attr('stroke-width', (l) => 0.6 + 2.4 * (l.weight / maxW))
      .attr('stroke-opacity', (l) => 0.15 + 0.5 * (l.weight / maxW));

    nodeSel = nodeG.selectAll('circle').data(graph.nodes, (n) => n.id).join('circle')
      .attr('r', (n) => n.r)
      .attr('class', (n) => (n.isOrigin ? 'node origin' : 'node'))
      .attr('tabindex', 0)
      .attr('aria-label', (n) => `${shortLabel(n)}: ${n.title}`)
      .on('click', (e, n) => { e.stopPropagation(); select(n.id); onSelect?.(n.id); })
      .on('dblclick', (e, n) => { e.stopPropagation(); onOpen?.(n.id); })
      .on('keydown', (e, n) => { if (e.key === 'Enter') { select(n.id); onSelect?.(n.id); } })
      .on('mouseenter focus', (e, n) => { hoverId = n.id; emphasise(); })
      .on('mouseleave blur', () => { hoverId = null; emphasise(); })
      .call(d3.drag()
        .on('start', (e, n) => { if (!e.active) sim.alphaTarget(0.2).restart(); n.fx = n.x; n.fy = n.y; })
        .on('drag', (e, n) => { n.fx = e.x; n.fy = e.y; })
        .on('end', (e, n) => { if (!e.active) sim.alphaTarget(0); if (!n.isOrigin || layout === 'timeline') { n.fx = null; n.fy = null; } }));
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
      .on('tick', tick);
    applyLayout();
    // Settle the layout up front (cheap for <100 nodes) so the first frame is
    // already readable and framed, then let it relax gently.
    sim.stop();
    sim.tick(300);
    tick();
    fit(40, 0);
    sim.alpha(0.03).restart();
    recolor();
    setLabels(showLabels);
    highlightSet = null;
    selectedId = selectedId && neighbours.has(selectedId) ? selectedId : null;
    emphasise();
  }

  function applyLayout() {
    if (!sim || !data) return;
    const { width } = size();
    const origin = data.nodes.find((n) => n.isOrigin);
    axisG.selectAll('*').remove();
    if (layout === 'timeline') {
      const years = data.nodes.map((n) => n.publication_year).filter(Boolean);
      const x = d3.scaleLinear().domain(d3.extent(years)).nice().range([-width * 0.42, width * 0.42]);
      if (origin) { origin.fx = null; origin.fy = null; }
      sim.force('x', d3.forceX((n) => (n.publication_year ? x(n.publication_year) : 0)).strength(0.9))
        .force('y', d3.forceY(0).strength(0.06))
        .force('charge', d3.forceManyBody().strength(-60));
      const ticks = x.ticks(Math.min(10, Math.max(2, Math.round(width / 90)))).filter(Number.isInteger);
      axisG.selectAll('line').data(ticks).join('line').attr('x1', (t) => x(t)).attr('x2', (t) => x(t));
      axisG.selectAll('text').data(ticks).join('text').attr('x', (t) => x(t)).attr('class', 'tick').text((t) => t);
    } else {
      if (origin) { origin.fx = 0; origin.fy = 0; }
      sim.force('x', d3.forceX().strength(0.04))
        .force('y', d3.forceY().strength(0.04))
        .force('charge', d3.forceManyBody().strength(-180));
    }
  }

  function setLayout(mode) {
    layout = mode;
    if (!sim) return;
    applyLayout();
    sim.stop();
    sim.alpha(1);
    for (let i = 0; i < 300; i++) sim.tick();
    tick();
    fit();
    sim.alpha(0.03).restart();
  }

  function tick() {
    linkSel.attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y)
      .attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
    nodeSel.attr('cx', (n) => n.x).attr('cy', (n) => n.y);
    labelSel.attr('x', (n) => n.x).attr('y', (n) => n.y + n.r + 11);
    if (layout === 'timeline' && data) {
      const ys = data.nodes.map((n) => n.y);
      axisG.selectAll('text.tick').attr('y', d3.min(ys) - 34);
      axisG.selectAll('line').attr('y1', d3.min(ys) - 26).attr('y2', d3.max(ys) + 30);
    }
  }

  function emphasise() {
    if (!nodeSel) return;
    const focus = hoverId || selectedId;
    const near = focus ? neighbours.get(focus) : null;
    const lit = (id) => {
      if (focus) return id === focus || near?.has(id);
      if (highlightSet) return highlightSet.has(id);
      return true;
    };
    nodeSel.classed('dim', (n) => !lit(n.id)).classed('selected', (n) => n.id === selectedId)
      .classed('match', (n) => !!highlightSet && !focus && highlightSet.has(n.id));
    labelSel.classed('dim', (n) => !lit(n.id)).classed('show', (n) => (!!focus || !!highlightSet) && lit(n.id));
    linkSel.classed('dim', (l) => (focus ? l.source.id !== focus && l.target.id !== focus : !!highlightSet && !(highlightSet.has(l.source.id) && highlightSet.has(l.target.id))))
      .classed('hot', (l) => !!focus && (l.source.id === focus || l.target.id === focus));
  }
  function select(id) { selectedId = id; emphasise(); }
  function highlight(ids) { highlightSet = ids && ids.size ? ids : null; emphasise(); }

  function recolor() {
    if (!data) return null;
    colorer = makeColorer(data.nodes, colorMode);
    nodeSel?.attr('fill', (n) => colorer.color(n));
    return colorer;
  }
  function setColorMode(mode) { colorMode = mode; return recolor(); }
  function setLabels(on) { showLabels = on; labelG.attr('data-mode', on ? 'all' : 'focus'); }

  function fit(pad = 40, duration = 500) {
    if (!data?.nodes.length) return;
    const { width, height } = size();
    svg.attr('viewBox', [-width / 2, -height / 2, width, height]);
    const xs = data.nodes.map((n) => n.x), ys = data.nodes.map((n) => n.y);
    const top = layout === 'timeline' ? 90 : 60; // leave room for the toolbar
    const [x0, x1, y0, y1] = [d3.min(xs) - 40, d3.max(xs) + 40, d3.min(ys) - top, d3.max(ys) + 40];
    const k = Math.min(2, 0.95 / Math.max((x1 - x0) / (width - pad), (y1 - y0) / (height - pad)));
    const t = d3.zoomIdentity.scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    if (duration) svg.transition().duration(duration).call(zoom.transform, t);
    else svg.call(zoom.transform, t);
  }

  const zoomBy = (f) => svg.transition().duration(250).call(zoom.scaleBy, f);

  /** Self-contained SVG with the current theme's colours baked in. */
  function exportSVG() {
    const clone = svg.node().cloneNode(true);
    const { width, height } = size();
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', width);
    clone.setAttribute('height', height);
    clone.querySelectorAll('.dim').forEach((el) => el.classList.remove('dim'));
    clone.insertAdjacentHTML('afterbegin', `<style>
      .links line{stroke:${cssVar('--edge')}} .links line.hot{stroke:${cssVar('--accent')}}
      .node{stroke:${cssVar('--node-stroke')};stroke-width:1.2} .node.origin{stroke:${cssVar('--accent')};stroke-width:3.5}
      .label{font:10px sans-serif;fill:${cssVar('--muted')};text-anchor:middle;paint-order:stroke;stroke:${cssVar('--bg')};stroke-width:3px}
      .label.origin{font-weight:700;fill:${cssVar('--text')};font-size:11px}
      .labels[data-mode=focus] .label:not(.show):not(.origin){display:none}
      .time-axis line{stroke:${cssVar('--border')};stroke-dasharray:2 4} .time-axis text{font:11px sans-serif;fill:${cssVar('--muted')};text-anchor:middle}</style>
      <rect x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}" fill="${cssVar('--bg')}"/>`);
    return new XMLSerializer().serializeToString(clone);
  }

  function exportPNG(scale = 2) {
    return new Promise((resolve, reject) => {
      const { width, height } = size();
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = width * scale; c.height = height * scale;
        const ctx = c.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
      };
      img.onerror = () => reject(new Error('PNG export failed'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(exportSVG());
    });
  }

  new ResizeObserver(() => {
    const { width, height } = size();
    svg.attr('viewBox', [-width / 2, -height / 2, width, height]);
  }).observe(container);

  return {
    render, select, highlight, fit, zoomBy, exportSVG, exportPNG,
    setColorMode, setLayout, setLabels, recolor,
    colorOf: (w) => (colorer ? colorer.color(w) : cssVar('--muted')),
    legend: () => colorer?.legend,
  };
}
