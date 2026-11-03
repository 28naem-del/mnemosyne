import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const documents = ['THREAT-MODEL.md', 'GOVERNANCE.md', 'MAINTAINERS.md'];

test('the actual offline npm pack file list includes linked root policy documents', t => {
  const cache = mkdtempSync(join(tmpdir(), 'mnemosyne-pack-docs-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--offline', '--json', '--cache', cache], {
    cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout);
  assert.equal(packed.length, 1);
  const files = new Set(packed[0].files.map(file => file.path));
  for (const file of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', ...documents]) assert.ok(files.has(file), 'Missing packed document: ' + file);
  for (const file of documents) {
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      if (/^(?:https?:|mailto:|#)/.test(match[1])) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), match[1].split(/[?#]/)[0]));
      assert.ok(files.has(target), file + ': missing packed link target ' + target);
    }
  }
  assert.ok(![...files].some(file => file.startsWith('.devcontainer/')), 'Do not ship development setup machinery');
  // This checks npm selection, not runtime dist completeness or installed exports.
});

test('the installed-artifact verifier requires the policy documents too', () => {
  const verifier = readFileSync(join(root, 'scripts/verify-package.mjs'), 'utf8');
  for (const file of documents) assert.ok(verifier.includes("'" + file + "'"), file);
});

test('the packaged contributor guide links to the repository devcontainer', () => {
  const guide = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
  assert.ok(guide.includes('https://github.com/28naem-del/mnemosyne/blob/main/.devcontainer/devcontainer.json'));
  assert.ok(!guide.includes('](.devcontainer/'));
});
