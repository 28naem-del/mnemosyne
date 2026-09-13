import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkDocLinks } from './check-doc-links.mjs';

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-doc-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

test('checks both destinations of a linked image', t => {
  const root = fixture(t, { 'README.md': '[![brand](assets/banner.svg)](docs/start.md#start)', 'assets/banner.svg': '<svg/>', 'docs/start.md': '# Start' });
  assert.equal(checkDocLinks(root).checked, 2);
  rmSync(join(root, 'assets/banner.svg'));
  assert.match(checkDocLinks(root).errors[0], /banner\.svg: missing target/);
});

test('rejects an anchor after its heading is renamed', t => {
  const root = fixture(t, { 'README.md': '[Inspect](docs/runtime.md#live-inspector)', 'docs/runtime.md': '# Inspector' });
  assert.match(checkDocLinks(root).errors[0], /missing anchor/);
});

test('ignores illustrative links inside fenced code, inline code and comments', t => {
  const root = fixture(t, { 'README.md': '```md\n[x](missing.md)\n```\n~~~\n[y](missing.md)\n~~~\n`[z](missing.md)`\n<!-- [a](missing.md) -->' });
  assert.deepEqual(checkDocLinks(root), { files: 1, checked: 0, errors: [] });
});

test('supports reference links, encoded paths, duplicate headings and website routes', t => {
  const root = fixture(t, { 'README.md': '[guide]: <docs/my%20guide.md#start-1>', 'docs/my guide.md': '# Start\n# Start', 'docs/site/guide.md': '[API](/docs/#api)', 'site/docs/index.html': '<h2 id="api">API</h2>' });
  assert.equal(checkDocLinks(root).errors.length, 0);
  assert.equal(checkDocLinks(root).checked, 2);
});

test('refuses repository escape', t => {
  const root = fixture(t, { 'README.md': '[outside](../secret.md)' });
  assert.match(checkDocLinks(root).errors[0], /escapes repository/);
});

test('example HTML ids and comments cannot satisfy a real fragment link', t => {
  const root = fixture(t, { 'README.md': '[sample](docs/guide.md#sample-only)\n[comment](docs/guide.md#comment-only)\n[inline](docs/guide.md#inline-only)\n[text](docs/guide.md#text-only)', 'docs/guide.md': '```html\n<div id="sample-only"></div>\n```\n<!-- <span id="comment-only"></span> -->\n`<span id="inline-only"></span>`\nThe field is id="text-only".' });
  const result = checkDocLinks(root);
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.every(error => error.includes('missing anchor')));
});
