#!/usr/bin/env node
/** Verify an npm-packed, independently installed artifact without rebuilding it. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const requiredAssets = [
  'package.json', 'README.md', 'LICENSE', 'NOTICE.md',
  'docs/deployment.md', 'docs/RUNTIME.md', 'docs/MIGRATION.md', 'docs/MAINTENANCE.md',
  'docs/EVALUATION.md', 'docs/LONGMEMEVAL.md', 'docs/LOCAL-MODELS.md',
  'docs/evaluation/BENCHMARKS.md', 'docs/evaluation/EVIDENCE-PROTOCOL.md', 'examples/local-semantic.ts',
  'docs/AGENT.md', 'docs/CONTEXT.md', 'docs/AGENT-EVALUATION.md', 'docs/OPERATIONS.md', 'docs/PROFILES.md', 'docs/BRIDGE.md',
  'dist/operations/worker.js', 'dist/evaluation/agent-benchmark.js', 'dist/evaluation/benchmark-memory.js',
  'dist/providers/local-model-worker.js', 'dist/providers/local-model-spec.js', 'dist/providers/local-model-dependencies.js',
  'dist/evaluation/corpus-cli.js', 'dist/evaluation/evidence-benchmark.js',
  'examples/agent-loop.ts', 'examples/adaptive-context.ts', 'examples/agent-benchmark.ts', 'examples/backup-restore.ts', 'examples/profiles.ts', 'examples/gradual-migration.ts',
  'dist/adapters/anthropic-memory.js', 'dist/adapters/provider-memory-tools.js',
  'dist/evaluation/learning-demo.js', 'dist/evaluation/longmemeval.js',
  'python/pyproject.toml', 'python/mnemosyne_memory/__init__.py',
];
const fail = message => { throw new Error(message); };
function readBounded(path, maximum) {
  const file = lstatSync(path);
  if (!file.isFile() || file.size > maximum) fail(`Expected a regular bounded file: ${path}`);
  return readFileSync(path);
}
function readJson(path) { return JSON.parse(readBounded(path, 8 * 1024 * 1024).toString('utf8')); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${label}`);
  return value;
}
function packagePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || isAbsolute(value)) fail('Invalid package file path');
  const path = value.startsWith('./') ? value.slice(2) : value;
  if (path.split('/').some(part => !part || part === '.' || part === '..')) fail('Invalid package file path');
  return path;
}
function within(root, path) {
  const rest = relative(root, path);
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}
function targets(value) {
  if (typeof value === 'string') return [packagePath(value)];
  // Explicit subpaths and condition objects are supported. New wildcard, null or
  // array export contracts require extending this verifier, never a silent skip.
  return Object.values(object(value, 'export conditions')).flatMap(targets);
}
function runProcess(executable, args, cwd) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH ?? ''}`;
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.signal || result.status !== 0) fail(`Installed process check failed: ${result.error?.message ?? result.signal ?? (result.stderr.trim() || result.status)}`);
  return result.stdout;
}
const runNode = (args, cwd) => runProcess(process.execPath, args, cwd);

try {
  const { values } = parseArgs({ options: { source: { type: 'string' }, pack: { type: 'string' }, install: { type: 'string' }, tarball: { type: 'string' } }, strict: true, allowPositionals: false });
  if (Object.values(values).length !== 4) fail('Usage: node scripts/verify-package.mjs --source package.json --pack pack.json --install ISOLATED_DIR --tarball PACKAGE.tgz');
  const source = object(readJson(resolve(values.source)), 'source manifest');
  if (typeof source.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(source.name) || typeof source.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(source.version)) fail('Invalid package identity');
  const packed = readJson(resolve(values.pack));
  if (!Array.isArray(packed) || packed.length !== 1) fail('Expected exactly one npm pack result');
  const pack = object(packed[0], 'npm pack result');
  if (pack.name !== source.name || pack.version !== source.version || !Array.isArray(pack.files)) fail('Packed package identity differs from source');
  const tarball = resolve(values.tarball), bytes = readBounded(tarball, 64 * 1024 * 1024);
  if (typeof pack.filename !== 'string' || !/^[A-Za-z0-9_.-]+\.tgz$/.test(pack.filename) || basename(tarball) !== pack.filename) fail('Tarball filename differs from npm pack result');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (pack.integrity !== integrity || pack.shasum !== createHash('sha1').update(bytes).digest('hex')) fail('Tarball bytes differ from npm pack integrity');
  const fileSizes = new Map();
  for (const file of pack.files) {
    const path = packagePath(file.path);
    if (fileSizes.has(path) || !Number.isSafeInteger(file.size) || file.size < 0) fail('Invalid or duplicate npm pack file entry');
    fileSizes.set(path, file.size);
  }
  const install = realpathSync(resolve(values.install)), packageRoot = join(install, 'node_modules', source.name);
  if (realpathSync(packageRoot) !== packageRoot) fail('Installed package must not resolve to a workspace link');
  const installed = object(readJson(join(packageRoot, 'package.json')), 'installed manifest');
  for (const field of ['name', 'version', 'exports', 'bin', 'main', 'module', 'types', 'type']) {
    if (JSON.stringify(installed[field]) !== JSON.stringify(source[field])) fail(`Installed ${field} differs from source manifest`);
  }
  // npm's installation receipt ties the isolated dependency to this tarball.
  const lock = readJson(join(install, 'package-lock.json'));
  const receipts = Object.entries(object(lock.packages, 'installed package receipts')).filter(([path]) => resolve(install, path) === packageRoot);
  if (receipts.length !== 1 || receipts[0][1]?.integrity !== integrity) fail('Installed package receipt differs from checked tarball');
  const declared = object(source.exports, 'package exports'), exportNames = Object.keys(declared);
  if (!exportNames.length || exportNames.some(name => name !== '.' && !/^\.\/[A-Za-z0-9_./-]+$/.test(name))) fail('Use explicit package export subpaths');
  const specifiers = exportNames.map(name => name === '.' ? source.name : `${source.name}${name.slice(1)}`);
  const files = new Set([...requiredAssets, ...Object.values(declared).flatMap(targets)]);
  for (const field of ['main', 'module', 'types']) if (source[field] !== undefined) files.add(packagePath(source[field]));
  const bins = object(source.bin, 'package bin map');
  if (!Object.keys(bins).length) fail('Package declares no executable');
  for (const [name, target] of Object.entries(bins)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) fail('Invalid executable name');
    const path = packagePath(target); files.add(path);
    if (realpathSync(join(install, 'node_modules', '.bin', name)) !== join(packageRoot, path)) fail(`Installed executable ${name} does not match its declaration`);
  }
  for (const path of files) {
    if (!fileSizes.has(path)) fail(`Packed artifact is missing ${path}`);
    const installedPath = join(packageRoot, path), file = lstatSync(installedPath);
    if (!file.isFile() || !within(packageRoot, realpathSync(installedPath)) || file.size !== fileSizes.get(path)) fail(`Installed artifact differs at ${path}`);
  }
  const importReport = JSON.parse(runNode(['--input-type=module', '--eval', `
    import { realpathSync } from 'node:fs';
    import { relative, isAbsolute, sep } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { pathToFileURL } from 'node:url';
    import { join } from 'node:path';
    import { createRequire } from 'node:module';
    const { packageRoot, specifiers, mcp } = JSON.parse(process.argv[1]);
    let mcpVersion;
    for (const specifier of specifiers) {
      const target = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
      const rest = relative(packageRoot, target);
      if (!rest || rest === '..' || rest.startsWith('..' + sep) || isAbsolute(rest)) throw new Error('Export resolved outside isolated package: ' + specifier);
      const loaded = await import(specifier);
      if (specifier === mcp) mcpVersion = loaded.VERSION;
    }
    let runtimeEntry;
    // Bind lookup to the installed worker so nested peer dependencies cannot
    // be hidden by an unrelated runtime at the consumer root. The pinned
    // runtime's require/import entry files are siblings in the same directory.
    try { runtimeEntry = createRequire(pathToFileURL(join(packageRoot, 'dist/providers/local-model-worker.js'))).resolve('@huggingface/transformers'); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    if (runtimeEntry) {
      const { assertLocalModelDependencies } = await import(pathToFileURL(join(packageRoot, 'dist/providers/local-model-dependencies.js')).href);
      assertLocalModelDependencies(runtimeEntry);
    }
    console.log(JSON.stringify({ imports: specifiers.length, mcpVersion, localModelDependencies: runtimeEntry ? 'checked' : 'not-installed' }));
  `, JSON.stringify({ packageRoot, specifiers, mcp: `${source.name}/mcp` })], install));
  if (importReport.imports !== specifiers.length || importReport.mcpVersion !== source.version) fail('Installed MCP/package versions disagree');
  if (typeof bins.mnemosy !== 'string') fail('Package must provide the mnemosy executable');
  const cli = join(install, 'node_modules', '.bin', 'mnemosy');
  if (runProcess(cli, ['--version'], install).trim() !== source.version) fail('Installed CLI/package versions disagree');
  const demo = JSON.parse(runProcess(cli, ['demo'], install));
  const learning = JSON.parse(runProcess(cli, ['learning-demo'], install));
  for (const [label, report] of [['demo', demo], ['learning-demo', learning]]) {
    if (!Number.isSafeInteger(report.checksTotal) || report.checksTotal < 1 || report.checksPassed !== report.checksTotal) fail(`Installed ${label} checks failed`);
  }
  if (learning.passed !== true || learning.kind !== 'deterministic integration demonstration' || learning.externalModelCalls !== 0 || learning.modelCalls !== 0) fail('Learning demo must pass without model calls');
  console.log(JSON.stringify({ name: source.name, version: source.version, filename: pack.filename, integrity, imports: importReport.imports, checkedFiles: files.size, localModelDependencies: importReport.localModelDependencies, demos: { demo: demo.checksPassed, learning: learning.checksPassed }, externalModelCalls: 0 }));
} catch (error) {
  console.error(`Package verification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
