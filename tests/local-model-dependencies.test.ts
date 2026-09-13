import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, fork } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { assertLocalModelDependencies } from '../src/providers/local-model-dependencies.js';

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mnemosyne-private-dependency-'))); roots.push(root);
  const runtime = join(root, 'node_modules/@huggingface/transformers');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', type: 'module', exports: { import: './esm-entry.js', require: './cjs-entry.cjs' } }));
  const marker = join(root, 'runtime-loaded');
  writeFileSync(join(runtime, 'esm-entry.js'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unexpected import'); throw new Error('Models must not load');`);
  writeFileSync(join(runtime, 'cjs-entry.cjs'), "throw new Error('Wrong resolution condition');");
  const resolver = join(root, 'resolve.mjs');
  writeFileSync(resolver, "process.stdout.write(import.meta.resolve('@huggingface/transformers'));\n");
  const entry = execFileSync(process.execPath, [resolver], { encoding: 'utf8', timeout: 5000 });
  expect(fileURLToPath(entry)).toBe(join(runtime, 'esm-entry.js'));
  return { root, runtime, marker, entry };
}
function sharp(parent: string, version: unknown, raw = false) {
  const directory = join(parent, 'node_modules/sharp'); mkdirSync(join(directory, 'dist'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), raw ? String(version) : JSON.stringify({ name: 'sharp', version, main: './dist/index.cjs', exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } } }));
  writeFileSync(join(directory, 'dist/index.cjs'), "throw new Error('Native code must not be imported');");
  writeFileSync(join(directory, 'dist/index.mjs'), "throw new Error('Native code must not be imported');");
}
async function workerMessage(root: string): Promise<unknown> {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['local-model-worker', 'local-model-dependencies', 'local-model-spec']) {
    const source = readFileSync(new URL(`../src/providers/${name}.ts`, import.meta.url), 'utf8');
    writeFileSync(join(root, `${name}.js`), transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText);
  }
  return new Promise((resolve, reject) => {
    const child = fork(join(root, 'local-model-worker.js'), [JSON.stringify({ kind: 'embed', cacheDir: root, allowDownload: false })], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let message: unknown;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture worker did not terminate')); }, 5000);
    child.once('message', value => { message = value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); resolve(message); });
  });
}
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('local model transitive dependency guard', () => {
  it('accepts the patched package layout that exports its entry but hides package.json', () => {
    const scope = fixture(); sharp(scope.runtime, '0.35.4');
    expect(() => createRequire(scope.entry).resolve('sharp/package.json')).toThrow(expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }));
    expect(() => assertLocalModelDependencies(scope.entry)).not.toThrow();
  });

  it('climbs past an unnamed dist manifest but rejects a different named owning package', () => {
    const scope = fixture(); sharp(scope.runtime, '0.35.4');
    const manifest = join(scope.runtime, 'node_modules/sharp/dist/package.json');
    writeFileSync(manifest, '{"type":"commonjs"}');
    expect(() => assertLocalModelDependencies(scope.entry)).not.toThrow();
    writeFileSync(manifest, '{"name":"different-package","version":"0.35.4"}');
    expect(() => assertLocalModelDependencies(scope.entry)).toThrow('stable sharp >=0.35.4');
  });

  it('bounds metadata traversal and rejects oversized metadata', () => {
    const scope = fixture(), directory = join(scope.runtime, 'node_modules/sharp');
    const path = Array.from({ length: 17 }, (_, i) => `level-${i}`).join('/');
    mkdirSync(join(directory, path), { recursive: true });
    writeFileSync(join(directory, path, 'index.cjs'), "throw new Error('Do not import');");
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'sharp', version: '0.35.4', exports: `./${path}/index.cjs` }));
    expect(() => assertLocalModelDependencies(scope.entry)).toThrow('stable sharp >=0.35.4');
    const oversized = fixture(); sharp(oversized.runtime, '0.35.4');
    writeFileSync(join(oversized.runtime, 'node_modules/sharp/package.json'), JSON.stringify({ name: 'sharp', version: '0.35.4', main: './dist/index.cjs', padding: 'x'.repeat(65_536) }));
    expect(() => assertLocalModelDependencies(oversized.entry)).toThrow('stable sharp >=0.35.4');
  });

  it('blocks the actual worker before runtime import and preserves the optional-package installation error', async () => {
    const vulnerable = fixture(); sharp(vulnerable.root, '0.35.4'); sharp(vulnerable.runtime, '0.34.5');
    expect(await workerMessage(vulnerable.root)).toEqual({ error: expect.stringContaining('stable sharp >=0.35.4') });
    expect(existsSync(vulnerable.marker)).toBe(false);
    const missing = fixture(); rmSync(missing.runtime, { recursive: true, force: true });
    expect(await workerMessage(missing.root)).toEqual({ error: 'Install optional @huggingface/transformers@3.8.1 to use local CPU models' });
    expect(existsSync(missing.marker)).toBe(false);
  });

  it('checks the nested copy used by the resolved runtime, not a safe root-level copy', () => {
    const scope = fixture(); sharp(scope.root, '0.35.4'); sharp(scope.runtime, '0.34.5');
    expect(() => assertLocalModelDependencies(scope.entry)).toThrow('stable sharp >=0.35.4');
    expect(existsSync(scope.marker)).toBe(false);
  });

  it('accepts a patched nested copy even when an unrelated root-level copy is old', () => {
    const scope = fixture(); sharp(scope.root, '0.34.5'); sharp(scope.runtime, '0.35.4');
    expect(() => assertLocalModelDependencies(scope.entry)).not.toThrow();
    expect(existsSync(scope.marker)).toBe(false);
  });

  it.each(['0.35.4', '0.35.5', '0.36.0', '1.0.0', '0.35.4+local.build'])('accepts stable minimum-compatible version %s from the actual hoisted dependency', version => {
    const scope = fixture(); sharp(scope.root, version);
    expect(() => assertLocalModelDependencies(scope.entry)).not.toThrow();
    expect(existsSync(scope.marker)).toBe(false);
  });

  it.each(['0.34.5', '0.34.99', '0.35.0', '0.35.3', '0.35.4-rc.1', '1.0.0-beta.1'])('rejects vulnerable or prerelease version %s before loading runtime code', version => {
    const scope = fixture(); sharp(scope.runtime, version);
    expect(() => assertLocalModelDependencies(scope.entry)).toThrow('stable sharp >=0.35.4');
    expect(existsSync(scope.marker)).toBe(false);
  });

  it.each([undefined, null, 35, true, {}, '', 'v0.35.4', '0.035.4', '0.35', '0.35.4 ', '9007199254740992.0.0'])('rejects malformed package version %j', version => {
    const scope = fixture(); sharp(scope.runtime, version);
    expect(() => assertLocalModelDependencies(scope.entry)).toThrow('docs/LOCAL-MODELS.md');
  });

  it('rejects missing or invalid package metadata with actionable guidance and no private paths', () => {
    const missing = fixture(), malformed = fixture(); sharp(malformed.runtime, '{broken private metadata', true);
    for (const scope of [missing, malformed]) {
      let message = '';
      try { assertLocalModelDependencies(scope.entry); } catch (error) { message = (error as Error).message; }
      expect(message).toContain('consumer root package.json');
      expect(message).toContain('"@huggingface/transformers":"3.8.1"');
      expect(message).toContain('"@huggingface/transformers@3.8.1":{"sharp":"0.35.4"}');
      expect(message).toContain('docs/LOCAL-MODELS.md');
      expect(message).not.toContain(scope.root); expect(message).not.toContain('private metadata');
      expect(existsSync(scope.marker)).toBe(false);
    }
  });
});
