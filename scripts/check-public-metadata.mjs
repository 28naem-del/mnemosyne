#!/usr/bin/env node
/** Offline checks for current first-party public surfaces, not historical research or upstream notices. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const support = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'docs/UPGRADE-STATUS.md',
  '.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml',
  'site/index.html', 'site/docs/index.html', 'site/features/index.html', 'site/compare/index.html'];
const emailPattern = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g;

function filesIn(directory, extension) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'vendor') return filesIn(path, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [path] : [];
  });
}

function decode(text) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', commat: '@', period: '.', colon: ':' };
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, value) => {
    if (!value.startsWith('#')) return named[value.toLowerCase()] ?? entity;
    const code = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function prose(text) {
  return text.replace(/<!--[^]*?-->/g, '').replace(/<(script|style|pre|code)\b[^>]*>[^]*?<\/\1>/gi, '')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[^]*?^\s*\1\s*$/gm, '').replace(/(`+)[^\n]*?\1/g, '');
}

export function checkPublicMetadata(root = repository) {
  const errors = [], read = file => readFileSync(join(root, file), 'utf8');
  const same = (file, field, actual, expected) => {
    if (actual !== expected) errors.push(`${file}: ${field} must match public identity (${expected})`);
  };
  try {
    const identity = JSON.parse(read('scripts/public-identity.json'));
    for (const field of ['company', 'contact', 'site', 'repository']) {
      if (typeof identity[field] !== 'string' || !identity[field]) throw new Error(`public identity is missing ${field}`);
    }
    const pkg = JSON.parse(read('package.json'));
    same('package.json', 'author.name', pkg.author?.name, identity.company);
    same('package.json', 'author.email', pkg.author?.email, identity.contact);
    same('package.json', 'author.url', pkg.author?.url, identity.site);
    same('package.json', 'homepage', pkg.homepage, identity.site);
    same('package.json', 'repository.url', pkg.repository?.url, identity.repository);
    same('package.json', 'bugs.url', pkg.bugs?.url, `${identity.repository}/issues`);

    // Read the repository's small inline-author TOML shape; fail if either field disappears.
    const python = read('python/pyproject.toml');
    const project = python.match(/^\[project\]\s*\n([^]*?)(?=^\[|$(?![^]))/m)?.[1] ?? '';
    const author = project.match(/^authors\s*=\s*\[([^]*?)\]/m)?.[1] ?? '';
    const value = (text, name) => text.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`))?.[1];
    same('python/pyproject.toml', 'author.name', value(author, 'name'), identity.company);
    same('python/pyproject.toml', 'author.email', value(author, 'email'), identity.contact);
    const urls = python.match(/^\[project\.urls\]\s*\n([^]*?)(?=^\[|$(?![^]))/m)?.[1] ?? '';
    for (const [key, expected] of Object.entries({ Homepage: identity.site, Repository: identity.repository, Issues: `${identity.repository}/issues` })) {
      same('python/pyproject.toml', key, value(urls, key), expected);
    }

    const files = new Set([...support, 'docs/README.md', 'site/README.md',
      ...filesIn(join(root, 'docs/site'), '.md').map(file => relative(root, file)),
      ...filesIn(join(root, 'site'), '.html').map(file => relative(root, file)),
      ...filesIn(join(root, '.github/ISSUE_TEMPLATE'), '.yml').map(file => relative(root, file))]);
    const contents = [];
    for (const file of files) {
      const required = support.includes(file) || file.startsWith('site/docs/reference/');
      if (!existsSync(join(root, file))) {
        if (required) errors.push(`${file}: missing required support page`);
        continue;
      }
      const text = prose(read(file));
      const links = [...text.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([^]*?)<\/a>/gi)]
        .map(match => [match[1], match[2]]);
      for (const match of text.matchAll(/\[([^\]]+)\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^\n]*?["'])?\s*\)/g)) links.push([match[2], match[1]]);
      // Also cover YAML urls, Markdown references/autolinks and unquoted HTML attributes.
      for (const match of decode(text).matchAll(/\bmailto:[^\s<>"'\])]+/gi)) links.push([match[0], '']);
      let contact = false;
      for (const [rawHref, label] of links) {
        const href = decode(rawHref);
        if (!/^mailto:/i.test(href)) continue;
        try {
          const [recipient, query = ''] = href.slice(7).split('?');
          const address = decodeURIComponent(recipient);
          same(file, 'mailto recipient', address, identity.contact);
          contact ||= address === identity.contact;
          for (const [key, value] of new URLSearchParams(query)) {
            if (/^(?:to|cc|bcc)$/i.test(key)) same(file, `mailto ${key}`, value, identity.contact);
          }
          for (const visible of decode(label.replace(/<[^>]+>/g, '')).match(emailPattern) ?? []) same(file, 'displayed contact', visible, address);
        } catch { errors.push(`${file}: invalid encoded mailto recipient`); }
      }
      // Prose only: technical examples, source identifiers, licenses and vendor notices are out of scope.
      const visible = decode(text.replace(/<[^>]+>/g, '').replace(/\]\([^)]*\)/g, ']'))
        .replace(/(\*{1,3}|_{1,3})([^\n]*?)\1/g, '$2');
      for (const address of visible.match(emailPattern) ?? []) {
        same(file, 'public contact', address, identity.contact);
        contact ||= address === identity.contact;
      }
      if (required && !contact) errors.push(`${file}: missing public support contact`);
      const decoded = decode(text);
      for (const match of decoded.matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
        let url;
        try { url = decodeURIComponent(match[0]); } catch { continue; }
        if (!url.startsWith(`${identity.repository}/`)) continue;
        const path = url.slice(identity.repository.length);
        if (/^\/(?:tree|blob)\/codex(?:\/|[?#]|$)/.test(path)) errors.push(`${file}: retired branch link (${url})`);
        if (/^\/blob\/v[^/]+\/(?:SECURITY|CONTRIBUTING)\.md(?:[?#]|$)/.test(path)) errors.push(`${file}: current support policy must link to main (${url})`);
      }
      contents.push(decoded);
    }
    const evidence = JSON.parse(read('site/release-evidence.json'));
    const releaseUrl = `${identity.repository}/releases/tag/v${pkg.version}`;
    const sourceAvailable = evidence.publication?.githubRelease === releaseUrl || contents.some(text => text.includes(releaseUrl));
    if (sourceAvailable && /\bpublication\s+pending\b/i.test(evidence.release ?? '')) {
      errors.push('site/release-evidence.json: publication pending contradicts the available tagged source release');
    }
    return { files: contents.length, errors };
  } catch (error) {
    errors.push(`Public metadata: ${error.message}`);
    return { files: 0, errors };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkPublicMetadata();
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
  else console.log(`Public metadata: package identity, source release status and ${result.files} public surfaces verified.`);
}
