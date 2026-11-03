import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Parent-supplied DockerHub library/node:24-alpine metadata, retrieved
// 2026-11-03T10:47:40Z. This is the multi-platform index, NOT an amd64/arm64
// manifest. Source contracts do not prove that an image builds or is available.
const index = 'sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85';
const image = 'node:24-alpine@' + index;
const source = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

function checkStages(text) {
  const stages = text.split(/\r?\n/).filter(line => /^\s*FROM\s/i.test(line));
  assert.deepEqual(stages, [
    'FROM ' + image + ' AS builder',
    'FROM ' + image + ' AS production',
  ]);
}

test('both Docker stages retain the same Node 24 Alpine multi-platform digest', () => {
  checkStages(source);
});

for (const stage of ['builder', 'production']) {
  test('rejects a floating ' + stage + ' image', () => {
    assert.throws(() => checkStages(source.replace('FROM ' + image + ' AS ' + stage,
      'FROM node:24-alpine AS ' + stage)));
  });
}

for (const [architecture, digest] of [
  ['amd64', 'sha256:4eefa1bfce4197942661ef9148247d779ddf1bb0ee006d3294a467609de60724'],
  ['arm64', 'sha256:e643984449ad25c88c0ff45094c74916806c9ee9dd1bc26c3593686ba2b853e4'],
]) {
  test('rejects accidentally substituting the ' + architecture + ' platform manifest', () => {
    assert.throws(() => checkStages(source.replaceAll(index, digest)));
  });
}

test('rejects a base version change or an additional unpinned stage', () => {
  assert.throws(() => checkStages(source.replaceAll('node:24-alpine@', 'node:25-alpine@')));
  assert.throws(() => checkStages(source + '\nFROM node:24-alpine AS extra\n'));
});
