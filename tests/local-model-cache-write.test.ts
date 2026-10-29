import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatedIt } from './env-gates.js';
import { writeModelFile } from '../src/local/embedding/model-file.js';
import { BUNDLED_EMBEDDING_MODEL, bundledModelDir, bundledModelFilePath, bundledModelStatus, fetchBundledModel, verifyBundledModel } from '../src/local/embedding/model-assets.js';
import { BUNDLED_RERANKER_MODEL, bundledRerankerDir, bundledRerankerFilePath, bundledRerankerStatus, fetchBundledReranker, verifyBundledReranker } from '../src/local/reranking/model-assets.js';

/**
 * Provisioning into a model cache another local user can write to. A symlink
 * planted where setup stages a download must not redirect the write: setup
 * stages under an unpredictable name with an exclusive create and renames
 * into place. The pinned files are served from the real cache through a
 * stubbed fetch, so these cases make no network request.
 */

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function serve(files: Record<string, { remote: string; local: string }>, path: (local: string) => string) {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requested.push(url);
    const entry = Object.values(files).find(spec => url.endsWith(`/${spec.remote}`));
    return entry ? new Response(readFileSync(path(entry.local))) : new Response('missing', { status: 404 });
  });
  return requested;
}

function plant(directory: string, files: Record<string, { local: string }>) {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-model-cache-')); roots.push(root);
  const victim = join(root, 'victim.txt'); writeFileSync(victim, 'owned by someone else'); chmodSync(victim, 0o644);
  mkdirSync(directory, { recursive: true });
  // The names a fixed-suffix staging scheme would use.
  for (const spec of Object.values(files)) symlinkSync(victim, join(directory, `${spec.local}.partial`));
  return victim;
}

function cache() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-model-target-')); roots.push(root); return root; }

gatedIt('model', bundledModelStatus().present)('embedder setup never writes through a symlink planted at a staging name', async () => {
  const target = cache(), files = BUNDLED_EMBEDDING_MODEL.files, local = (name: string) => join(bundledModelDir(), name);
  const victim = plant(bundledModelDir(target), files);
  const requested = serve(files, local);
  const status = await fetchBundledModel({ cacheDir: target });
  expect(readFileSync(victim, 'utf8')).toBe('owned by someone else'); expect(statSync(victim).mode & 0o777).toBe(0o644);
  expect(status.present).toBe(true); expect(requested).toHaveLength(Object.keys(files).length);
  for (const file of Object.keys(files) as (keyof typeof files)[]) {
    const path = bundledModelFilePath(file, target);
    expect(lstatSync(path).isFile()).toBe(true); expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  expect(() => verifyBundledModel(target)).not.toThrow();
  // Only the planted links remain beside the verified files; no staging file is left behind.
  expect(readdirSync(bundledModelDir(target)).sort()).toEqual(Object.values(files).flatMap(spec => [spec.local, `${spec.local}.partial`]).sort());
});

gatedIt('reranker', bundledRerankerStatus().present)('reranker setup never writes through a symlink planted at a staging name', async () => {
  const target = cache(), files = BUNDLED_RERANKER_MODEL.files, local = (name: string) => join(bundledRerankerDir(), name);
  const victim = plant(bundledRerankerDir(target), files);
  serve(files, local);
  const status = await fetchBundledReranker({ cacheDir: target });
  expect(readFileSync(victim, 'utf8')).toBe('owned by someone else'); expect(statSync(victim).mode & 0o777).toBe(0o644);
  expect(status.present).toBe(true);
  for (const file of Object.keys(files) as (keyof typeof files)[]) expect(lstatSync(bundledRerankerFilePath(file, target)).isFile()).toBe(true);
  expect(() => verifyBundledReranker(target)).not.toThrow();
});

it('replaces a symlink at the target instead of writing through it, and leaves no staging file', () => {
  const root = cache(), victim = join(root, 'victim.txt'), target = join(root, 'model.onnx');
  writeFileSync(victim, 'owned by someone else'); chmodSync(victim, 0o644); symlinkSync(victim, target);
  writeModelFile(target, Buffer.from('verified bytes'));
  expect(readFileSync(victim, 'utf8')).toBe('owned by someone else'); expect(statSync(victim).mode & 0o777).toBe(0o644);
  expect(lstatSync(target).isFile()).toBe(true); expect(statSync(target).mode & 0o777).toBe(0o600); expect(readFileSync(target, 'utf8')).toBe('verified bytes');
  expect(readdirSync(root).sort()).toEqual(['model.onnx', 'victim.txt']);
  expect(() => writeModelFile(join(root, 'missing', 'model.onnx'), Buffer.from('x'))).toThrow();
  expect(readdirSync(root).sort()).toEqual(['model.onnx', 'victim.txt']);
});
