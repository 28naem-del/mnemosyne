import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const verifier = resolve('scripts/verify-package.mjs');
let root: string, source: string, baseline: string, scenario: string, pack: string, tarball: string;
const write = (path: string, value: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
type FixtureDocument = Record<string, unknown> & { packages?: Record<string, { integrity: string }> };
const edit = (path: string, change: (value: FixtureDocument) => void) => { const value: FixtureDocument = json(path); change(value); write(path, JSON.stringify(value)); };
function npm(args: string[], cwd: string) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', timeout: 15_000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); return result.stdout;
}
function verify() {
  const result = spawnSync(process.execPath, [verifier, '--source', join(source, 'package.json'), '--pack', pack, '--install', scenario, '--tarball', tarball], { encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); return result;
}
const installed = (path: string) => join(scenario, 'node_modules/mnemosy-ai', path);

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mnemosyne-package-verifier-'))); source = join(root, 'source'); baseline = join(root, 'baseline');
  const declaration = { name: 'mnemosy-ai', version: '2.0.0-rc.5', type: 'module', bin: { mnemosy: './dist/cli.js' }, exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './mcp': { types: './dist/mcp.d.ts', import: './dist/mcp.js' },
    './future': { types: './dist/future.d.ts', import: './dist/future.js' },
  } };
  write(join(source, 'package.json'), JSON.stringify(declaration));
  for (const file of ['README.md', 'LICENSE', 'NOTICE.md', 'docs/deployment.md', 'docs/RUNTIME.md', 'docs/MIGRATION.md', 'docs/MAINTENANCE.md', 'docs/EVALUATION.md', 'docs/LONGMEMEVAL.md',
    'assets/mnemosyne-logo.svg', 'assets/social-preview.png', 'docs/README.md', 'ARCHITECTURE.md', 'SECURITY.md', 'CONTRIBUTING.md',
    'docs/LOCAL-MODELS.md', 'docs/evaluation/BENCHMARKS.md', 'docs/evaluation/EVIDENCE-PROTOCOL.md', 'examples/local-semantic.ts',
    'dist/providers/local-model-worker.js', 'dist/providers/local-model-spec.js', 'dist/providers/local-model-dependencies.js',
    'dist/evaluation/corpus-cli.js', 'dist/evaluation/evidence-benchmark.js',
    'docs/AGENT.md', 'docs/CONTEXT.md', 'docs/AGENT-EVALUATION.md', 'docs/OPERATIONS.md', 'docs/PROFILES.md', 'docs/BRIDGE.md',
    'dist/operations/worker.js', 'dist/evaluation/agent-benchmark.js', 'dist/evaluation/benchmark-memory.js',
    'examples/agent-loop.ts', 'examples/adaptive-context.ts', 'examples/agent-benchmark.ts', 'examples/backup-restore.ts', 'examples/profiles.ts', 'examples/gradual-migration.ts',
    'dist/adapters/anthropic-memory.js', 'dist/adapters/provider-memory-tools.js', 'dist/evaluation/learning-demo.js', 'dist/evaluation/longmemeval.js', 'python/pyproject.toml', 'python/mnemosyne_memory/__init__.py',
    'dist/index.d.ts', 'dist/mcp.d.ts', 'dist/future.d.ts']) write(join(source, file), '// synthetic package fixture\n');
  write(join(source, 'dist/index.js'), 'export const value = true;\n');
  write(join(source, 'dist/providers/local-model-dependencies.js'), readFileSync(resolve('dist/providers/local-model-dependencies.js'), 'utf8'));
  write(join(source, 'dist/future.js'), 'export const future = true; // deliberately longer than an import failure\n');
  write(join(source, 'dist/mcp.js'), "export const VERSION = '2.0.0-rc.5';\n");
  write(join(source, 'dist/cli.js'), `#!/usr/bin/env node
if (process.argv[2] === '--version') console.log('2.0.0-rc.5');
else console.log(JSON.stringify({ checksTotal: 1, checksPassed: 1, passed: true, kind: 'deterministic integration demonstration', externalModelCalls: 0, modelCalls: 0 }));
`);
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', root], source));
  tarball = join(root, packed[0].filename); write(join(root, 'pack.json'), JSON.stringify(packed));
  npm(['install', '--prefix', baseline, '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball], root);
}, 30_000);
beforeEach(() => {
  scenario = mkdtempSync(join(root, 'case-')); cpSync(baseline, scenario, { recursive: true, verbatimSymlinks: true });
  pack = join(scenario, 'pack.json'); cpSync(join(root, 'pack.json'), pack);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('shared installed artifact verifier', () => {
  it('discovers an additional export and checks the actual isolated package and demos', () => {
    const result = verify(); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ imports: 3, version: '2.0.0-rc.5', demos: { demo: 1, learning: 1 }, externalModelCalls: 0 });
  });
  function optionalRuntime(parent: string, sharpVersion: string) {
    const runtime = join(parent, 'node_modules/@huggingface/transformers');
    write(join(runtime, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', version: '3.8.1', exports: { import: './dist/runtime.mjs', require: './dist/runtime.cjs' } }));
    for (const name of ['runtime.mjs', 'runtime.cjs']) write(join(runtime, 'dist', name), 'throw new Error("Optional inference must not execute during package verification");');
    const sharp = join(runtime, 'node_modules/sharp');
    write(join(sharp, 'package.json'), JSON.stringify({ name: 'sharp', version: sharpVersion, exports: './dist/index.cjs' }));
    write(join(sharp, 'dist/index.cjs'), 'throw new Error("Native code must not execute during metadata verification");');
  }
  it('checks installed optional dependencies without importing native inference code', () => {
    optionalRuntime(scenario, '0.35.4');
    const result = verify(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).localModelDependencies).toBe('checked');
  });
  it('rejects a vulnerable nested runtime even when the consumer root has a patched copy', () => {
    optionalRuntime(scenario, '0.35.4'); optionalRuntime(installed(''), '0.34.5');
    const result = verify(); expect(result.status).toBe(1);
    expect(result.stderr).toContain('sharp >=0.35.4');
  });
  it('rejects a declaration missing from the packed inventory', () => {
    const value = json(pack); value[0].files = value[0].files.filter((file: { path: string }) => file.path !== 'dist/future.d.ts'); write(pack, JSON.stringify(value));
    const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain('missing dist/future.d.ts');
  });
  it('rejects a declaration missing from the installed package', () => {
    rmSync(installed('dist/future.d.ts')); const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain('dist/future.d.ts');
  });
  it.each(['dist/operations/worker.js', 'docs/PROFILES.md', 'examples/agent-loop.ts', 'docs/BRIDGE.md', 'examples/gradual-migration.ts',
    'assets/social-preview.png', 'assets/mnemosyne-logo.svg', 'docs/README.md', 'SECURITY.md',
    'dist/providers/local-model-worker.js', 'dist/providers/local-model-dependencies.js', 'dist/evaluation/corpus-cli.js', 'docs/evaluation/BENCHMARKS.md'])('rejects an omitted required candidate asset %s', path => {
    const value = json(pack); value[0].files = value[0].files.filter((file: { path: string }) => file.path !== path); write(pack, JSON.stringify(value));
    const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain(`missing ${path}`);
  });
  it.each(['version', 'exports', 'bin'])('rejects installed %s drift from the source contract', field => {
    edit(installed('package.json'), value => { value[field] = field === 'version' ? '2.0.0-rc.6' : {}; });
    const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain(`Installed ${field} differs`);
  });
  it('executes newly declared exports rather than checking only their filenames', () => {
    const old = readFileSync(installed('dist/future.js'), 'utf8'); write(installed('dist/future.js'), "throw new Error('NEW_EXPORT_EXECUTED');".padEnd(Buffer.byteLength(old), ' '));
    const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain('NEW_EXPORT_EXECUTED');
  });
  it('rejects a workspace-linked package', () => {
    rmSync(installed(''), { recursive: true }); symlinkSync(source, installed(''), 'dir');
    const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain('workspace link');
  });
  it.each(['dist/mcp.js', 'dist/cli.js'])('rejects %s version disagreement', path => {
    write(installed(path), readFileSync(installed(path), 'utf8').replace('2.0.0-rc.5', '2.0.0-rc.6'));
    const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain('versions disagree');
  });
  it('rejects learning demonstrations that report external model calls', () => {
    const path = installed('dist/cli.js'); write(path, readFileSync(path, 'utf8').replace('externalModelCalls: 0', 'externalModelCalls: 1'));
    const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain('without model calls');
  });
  it('executes the installed bin shim and rejects a broken executable header', () => {
    const path = installed('dist/cli.js'); write(path, readFileSync(path, 'utf8').replace('#!', '//'));
    const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain('process check failed');
  });
  it('rejects an installation receipt for a different artifact', () => {
    edit(join(scenario, 'package-lock.json'), value => {
      const receipt = value.packages?.['node_modules/mnemosy-ai'];
      if (!receipt) throw new Error('Missing fixture package receipt');
      receipt.integrity = 'sha512-different';
    });
    const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain('receipt differs');
  });
  it('rejects tarball bytes that no longer match npm pack', () => {
    const changed = join(scenario, 'changed', json(pack)[0].filename); write(changed, 'different tarball');
    const original = tarball; tarball = changed;
    try { const result = verify(); expect(result.status).toBe(1); expect(result.stderr).toContain('pack integrity'); } finally { tarball = original; }
  });
});
