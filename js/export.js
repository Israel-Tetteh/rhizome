// BibTeX and RIS export, both import directly into Zotero, Mendeley and EndNote.

import { authorNames, venue, bareDoi, doiUrl } from './openalex.js?v=20261120c';

const splitName = (full) => {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: '' };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
};

const BIB_TYPES = {
  article: 'article', review: 'article', letter: 'article', editorial: 'article',
  book: 'book', 'book-chapter': 'incollection', dissertation: 'phdthesis',
  preprint: 'misc', dataset: 'misc', 'proceedings-article': 'inproceedings',
};
const RIS_TYPES = {
  article: 'JOUR', review: 'JOUR', letter: 'JOUR', editorial: 'JOUR',
  book: 'BOOK', 'book-chapter': 'CHAP', dissertation: 'THES',
  preprint: 'JOUR', dataset: 'DATA', 'proceedings-article': 'CPAPER',
};

const bibEscape = (s) => String(s ?? '').replace(/[{}]/g, '').replace(/([&%$#_])/g, '\\$1');
const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '');

function citeKey(w, used) {
  const first = authorNames(w)[0];
  const fam = first ? splitName(first).family : 'anon';
  const word = (stripTags(w.title).match(/[A-Za-z]{4,}/) || ['paper'])[0];
  let base = `${fam}${w.publication_year || ''}${word}`
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  let key = base, i = 1;
  while (used.has(key)) key = base + String.fromCharCode(96 + ++i);
  used.add(key);
  return key;
}

export function toBibTeX(works) {
  const used = new Set();
  return works.map((w) => {
    const type = BIB_TYPES[w.type] || 'article';
    const b = w.biblio || {};
    const pages = b.first_page ? (b.last_page ? `${b.first_page}--${b.last_page}` : b.first_page) : '';
    const authors = authorNames(w).map((n) => { const p = splitName(n); return p.given ? `${p.family}, ${p.given}` : p.family; });
    const containerField = type === 'incollection' ? 'booktitle' : type === 'inproceedings' ? 'booktitle' : 'journal';
    const fields = [
      ['title', `{${bibEscape(stripTags(w.title))}}`],
      ['author', authors.map(bibEscape).join(' and ')],
      [containerField, bibEscape(venue(w))],
      ['year', w.publication_year],
      ['volume', b.volume], ['number', b.issue], ['pages', pages],
      ['doi', bareDoi(w)], ['url', doiUrl(w) || `https://openalex.org/${w.id}`],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    return `@${type}{${citeKey(w, used)},\n${fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n')}\n}`;
  }).join('\n\n') + '\n';
}

export function toRIS(works) {
  return works.map((w) => {
    const b = w.biblio || {};
    const lines = [['TY', RIS_TYPES[w.type] || 'JOUR']];
    authorNames(w).forEach((n) => { const p = splitName(n); lines.push(['AU', p.given ? `${p.family}, ${p.given}` : p.family]); });
    lines.push(['TI', stripTags(w.title)]);
    if (venue(w)) lines.push([w.type === 'book-chapter' ? 'T2' : 'JO', venue(w)]);
    if (w.publication_year) lines.push(['PY', String(w.publication_year)]);
    if (b.volume) lines.push(['VL', b.volume]);
    if (b.issue) lines.push(['IS', b.issue]);
    if (b.first_page) lines.push(['SP', b.first_page]);
    if (b.last_page) lines.push(['EP', b.last_page]);
    if (bareDoi(w)) lines.push(['DO', bareDoi(w)]);
    lines.push(['UR', doiUrl(w) || `https://openalex.org/${w.id}`]);
    lines.push(['ER', '']);
    return lines.map(([k, v]) => `${k}  - ${v}`).join('\n');
  }).join('\n\n') + '\n';
}

export function toCSV(works) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['title', 'authors', 'year', 'venue', 'citations', 'doi', 'openalex_id'];
  const rows = works.map((w) => [stripTags(w.title), authorNames(w).join('; '), w.publication_year, venue(w), w.cited_by_count, bareDoi(w), w.id]);
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
