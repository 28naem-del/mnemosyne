#!/usr/bin/env node
/** TEMPORARY PR bootstrap evidence, NOT the final reproducible consumer install.
 * Remove the workflow capture/export once reviewed templates + binder replace
 * range-resolving smoke installs, or move to reviewed explicit maintenance.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const fail = message => { throw new Error(message); };
function read(path, limit = 8 * 1024 * 1024) {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > limit) fail('Expected bounded regular evidence input: ' + path);
  return readFileSync(path);
}
function parse(bytes) { return JSON.parse(bytes.toString('utf8')); }
function localTarball(specifier, install, tarball) {
  if (typeof specifier !== 'string' || !specifier.startsWith('file:') ||
      realpathSync(resolve(install, specifier.slice(5))) !== realpathSync(tarball)) fail('Consumer does not reference the checked local tarball');
}

// This exports the actual npm outputs unchanged, not a newly resolved graph.
// Metadata is supplied by the CLI from real git/npm; injection here is only for
// dependency-free fixture tests, not an install/audit/build attestation.
export function captureConsumer({ profile, source, pack, install, tarball, out, metadata }) {
  if (!['core', 'optional'].includes(profile)) fail('Unknown consumer profile');
  if (!/^[a-f0-9]{40}$/.test(metadata.sourceSHA) || !/^v\d+\.\d+\.\d+/.test(metadata.node) || !/^\d+\.\d+\.\d+/.test(metadata.npm)) fail('Invalid tool/source provenance');
  const sourceBytes = read(source), sourceManifest = parse(sourceBytes);
  const packBytes = read(pack), packed = parse(packBytes);
  if (!Array.isArray(packed) || packed.length !== 1) fail('Expected one npm pack result');
  const info = packed[0], bytes = read(tarball, 64 * 1024 * 1024);
  if (info.name !== sourceManifest.name || info.version !== sourceManifest.version ||
      basename(tarball) !== info.filename || !/^[A-Za-z0-9_.-]+\.tgz$/.test(info.filename)) fail('Packed identity differs from source');
  const integrity = 'sha512-' + hash(bytes, 'sha512', 'base64');
  if (info.integrity !== integrity || info.shasum !== hash(bytes, 'sha1')) fail('Tarball bytes differ from pack JSON');
  const manifestBytes = read(join(install, 'package.json')), lockBytes = read(join(install, 'package-lock.json'));
  const manifest = parse(manifestBytes), lock = parse(lockBytes);
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) fail('Expected actual npm v3 consumer lock');
  localTarball(manifest.dependencies?.[info.name], install, tarball);
  if (!isDeepStrictEqual(lock.packages[''].dependencies, manifest.dependencies)) fail('Consumer manifest/lock roots disagree');
  const receipt = lock.packages['node_modules/' + info.name];
  if (receipt?.version !== info.version || receipt.integrity !== integrity || receipt.link) fail('Lock does not bind the installed tarball');
  localTarball(receipt.resolved, install, tarball);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
    if (!isDeepStrictEqual(receipt[field], sourceManifest[field])) fail('Tarball receipt differs from source ' + field);
  }
  if (profile === 'core') {
    if (manifest.dependencies['@huggingface/transformers'] || lock.packages['node_modules/@huggingface/transformers']) fail('Core profile unexpectedly includes transformers');
  } else {
    if (manifest.dependencies['@huggingface/transformers'] !== '3.8.1' ||
        manifest.overrides?.['@huggingface/transformers@3.8.1']?.sharp !== '0.35.5' ||
        lock.packages['node_modules/@huggingface/transformers']?.version !== '3.8.1' ||
        !Object.entries(lock.packages).some(([path, entry]) => (path === 'node_modules/sharp' || path.endsWith('/node_modules/sharp')) && entry.version === '0.35.5')) fail('Optional runtime/override graph missing');
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || path === 'node_modules/' + info.name) continue;
    if (typeof entry.resolved !== 'string' || !entry.integrity || entry.link) fail('Incomplete registry evidence at ' + path);
    const url = new URL(entry.resolved);
    if (url.protocol !== 'https:' || url.username || url.password) fail('Do not export credential-bearing or non-registry resolution');
  }
  if (profile === 'optional') {
    const core = parse(read(join(out, 'core/provenance.json')));
    if (core.sourceSHA !== metadata.sourceSHA || core.node !== metadata.node || core.npm !== metadata.npm ||
        core.tarball.sha256 !== hash(bytes) || core.sourceManifestSHA256 !== hash(sourceBytes) ||
        hash(read(join(out, 'core/pack.json'))) !== hash(packBytes)) fail('Core/optional evidence must use the same source, tools and packed bytes');
  }
  // Exact file allowlist: never copy npm config, environment, node_modules,
  // source files, tarball contents or arbitrary runner directories.
  const files = { 'package.json': manifestBytes, 'package-lock.json': lockBytes, 'pack.json': packBytes };
  const provenance = {
    kind: 'TEMPORARY PR bootstrap; generated locks, not reproducibility closure',
    profile, sourceSHA: metadata.sourceSHA, node: metadata.node, npm: metadata.npm,
    sourceManifestSHA256: hash(sourceBytes),
    tarball: { filename: info.filename, name: info.name, version: info.version, sha256: hash(bytes), integrity, shasum: info.shasum },
    installCommand: profile === 'core'
      ? 'npm install --prefix "$MNEMOSYNE_SMOKE_DIR" --ignore-scripts --omit=dev --no-audit --no-fund "$PWD/$PACK_NAME"'
      : 'npm install --prefix "$MNEMOSYNE_SMOKE_DIR" --ignore-scripts --omit=dev --no-audit --no-fund',
    optionalMutation: profile === 'optional' ? { transformers: '3.8.1', sharpOverride: '0.35.5' } : null,
    files: Object.entries(files).map(([path, data]) => ({ path, bytes: data.length, sha256: hash(data) })),
  };
  mkdirSync(out, { recursive: true });
  const directory = join(out, profile);
  mkdirSync(directory); // Fail rather than mix outputs from a previous capture.
  for (const [path, data] of Object.entries(files)) writeFileSync(join(directory, path), data, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return provenance;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['profile', 'source', 'pack', 'install', 'tarball', 'out'].map(name => [name, { type: 'string' }])), strict: true, allowPositionals: false });
    if (Object.keys(values).length !== 6) fail('Expected --profile --source --pack --install --tarball --out');
    const metadata = {
      sourceSHA: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      node: process.version,
      npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    };
    captureConsumer({ ...values, metadata });
    console.log('Captured temporary ' + values.profile + ' consumer lock evidence');
  } catch (error) {
    console.error('Consumer evidence capture failed: ' + error.message);
    process.exitCode = 1;
  }
}
