#!/usr/bin/env node
/** Offline navigation checks for the Markdown syntax used in this repository. */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outside = (root, file) => relative(root, file) === '..' || relative(root, file).startsWith(`..${sep}`);

function prose(text) {
  let fence;
  return text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  }).join('\n').replace(/<!--[^]*?-->/g, match => match.replace(/[^\n]/g, ''));
}

function anchors(text, markdown) {
  const ids = new Set();
  const content = markdown ? prose(text) : text.replace(/<!--[^]*?-->/g, '');
  const markup = markdown ? content.replace(/(`+)[^\n]*?\1/g, '') : content;
  for (const match of markup.matchAll(/[<][a-z][^>]*?\b(?:id|name)=["']([^"']+)["'][^>]*>/gi)) ids.add(match[1]);
  if (markdown) for (const match of content.matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const base = match[1].replace(/<[^>]+>/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    let slug = base, suffix = 0;
    while (ids.has(slug)) slug = `${base}-${++suffix}`;
    ids.add(slug);
  }
  return ids;
}

function markdownFiles(directory, recursive) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.md')) return [path];
    return recursive && entry.isDirectory() && !entry.name.startsWith('.') ? markdownFiles(path, true) : [];
  });
}

export function checkDocLinks(root = repository) {
  root = realpathSync(root);
  const files = [...markdownFiles(root, false), ...markdownFiles(join(root, 'docs'), true),
    ...markdownFiles(join(root, 'examples'), true), ...markdownFiles(join(root, 'site'), false)];
  const errors = [], cache = new Map();
  let checked = 0;
  for (const file of files) {
    const text = prose(readFileSync(file, 'utf8')).replace(/(`+)[^\n]*?\1/g, '');
    const links = [...text.matchAll(/\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g),
      ...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm),
      ...text.matchAll(/<(?:a|img|source)\b[^>]*?\b(?:href|src)=["']([^"']+)["'][^>]*>/g)];
    for (const match of links) {
      const href = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
      const label = `${relative(root, file)}:${text.slice(0, match.index).split('\n').length} → ${href}`;
      try {
        const [location, fragment] = href.split('#');
        const path = decodeURIComponent(location.split('?')[0]);
        // Curated website guides use site-root routes; all other links are file-relative.
        const isSiteGuide = relative(join(root, 'docs', 'site'), file).split(sep)[0] !== '..';
        let target = path ? (path.startsWith('/') ? resolve(root, isSiteGuide ? 'site' : '.', `.${path}`) : resolve(dirname(file), path)) : file;
        if (outside(root, target)) throw new Error('target escapes repository');
        if (!existsSync(target)) throw new Error('missing target');
        if (statSync(target).isDirectory()) target = ['README.md', 'index.html'].map(name => join(target, name)).find(existsSync) ?? target;
        if (outside(root, realpathSync(target))) throw new Error('target resolves outside repository');
        if (fragment && ['.md', '.html'].includes(extname(target))) {
          if (!cache.has(target)) cache.set(target, anchors(readFileSync(target, 'utf8'), extname(target) === '.md'));
          if (!cache.get(target).has(decodeURIComponent(fragment))) throw new Error('missing anchor');
        }
        checked++;
      } catch (error) { errors.push(`${label}: ${error.message}`); }
    }
  }
  return { files: files.length, checked, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkDocLinks();
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
  else console.log(`Documentation links: ${result.checked} local targets across ${result.files} Markdown files verified.`);
}
