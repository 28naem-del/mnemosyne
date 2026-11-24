#!/usr/bin/env node
/** Bind reviewed, npm-generated consumer locks to the exact current npm pack.
 * No dependency resolution, installation, audit, network, or registry rewrite.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, posix, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const defaults = fileURLToPath(new URL('./consumer-locks/', import.meta.url));
const localPath = 'node_modules/mnemosy-ai';
const fields = ['name', 'version', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies', 'overrides', 'engines', 'os', 'cpu', 'libc', 'bin', 'license'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function contract(manifest) {
  const result = Object.fromEntries(fields.filter(field => manifest[field] !== undefined).map(field => [field, manifest[field]]));
  if (result.bin && typeof result.bin === 'object') result.bin = Object.fromEntries(Object.entries(result.bin).map(([key, path]) => [key, path.replace(/^\.\//, '')]));
  return canonical(result);
}
export function registryRecords(lock) {
  return canonical(Object.fromEntries(Object.entries(lock.packages).filter(([path]) => path && path !== localPath)));
}
export const registryHash = lock => hash(JSON.stringify(registryRecords(lock)));
const fail = message => { throw new Error(message); };
function read(path, maximum = 2 * 1024 * 1024) {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > maximum) fail('Expected bounded regular input: ' + path);
  return readFileSync(path);
}
const parse = bytes => JSON.parse(bytes.toString('utf8'));
function same(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) fail(label);
}
function dependencyPath(packages, issuer, name) {
  let cursor = issuer;
  for (;;) {
    const path = (cursor ? cursor + '/' : '') + 'node_modules/' + name;
    if (posix.basename(cursor) !== 'node_modules' && packages[path]) return path;
    if (!cursor) return null;
    const parent = posix.dirname(cursor);
    cursor = parent === '.' ? '' : parent;
  }
}
export function validateClosure(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.[''] || !lock.packages[localPath]) fail('Expected complete npm v3 consumer lock');
  const name = '(?:@[a-zA-Z0-9._-]+/)?[a-zA-Z0-9._-]+';
  const pathPattern = new RegExp('^node_modules/' + name + '(?:/node_modules/' + name + ')*$');
  let edges = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path && (!pathPattern.test(path) || path.split('/').some(part => part === '.' || part === '..'))) fail('Unsafe lock path: ' + path);
    if (entry.link || entry.dev) fail('Consumer lock must not contain workspace links or dev-only records');
    if (path && path !== localPath) {
      if (!entry.version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')) fail('Registry identity/integrity missing at ' + path);
      const url = new URL(entry.resolved);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('Unsafe registry resolution at ' + path);
    }
    const required = { ...entry.dependencies, ...entry.optionalDependencies };
    for (const peer of Object.keys(entry.peerDependencies ?? {})) if (!entry.peerDependenciesMeta?.[peer]?.optional) required[peer] = entry.peerDependencies[peer];
    for (const dependency of Object.keys(required)) {
      if (!(new RegExp('^' + name + '$')).test(dependency) || !dependencyPath(lock.packages, path, dependency)) fail('Missing locked dependency ' + dependency + ' from ' + (path || 'consumer'));
      edges++;
    }
  }
  return edges;
}

export function loadTemplate(profile, templateDir = defaults) {
  if (!['core', 'optional'].includes(profile)) fail('Unknown consumer profile');
  const descriptor = parse(read(join(templateDir, 'templates.json'))), record = descriptor.profiles[profile];
  const files = {};
  for (const filename of ['package.json', 'package-lock.json', 'provenance.json']) {
    const bytes = read(join(templateDir, profile, filename));
    if (hash(bytes) !== record.files[filename]) fail('Template tamper: ' + profile + '/' + filename);
    files[filename] = parse(bytes);
  }
  const manifest = files['package.json'], lock = files['package-lock.json'];
  validateClosure(lock);
  if (registryHash(lock) !== record.registrySHA256) fail('Registry template drift');
  same(lock.packages[''].dependencies, manifest.dependencies, 'Template manifest/lock disagree');
  const receipt = lock.packages[localPath], expected = { ...descriptor.contract };
  delete expected.name; // npm tarball receipts do not include the package name.
  same(contract(receipt), expected, 'Template package contract differs');
  if (profile === 'core') {
    same(Object.keys(manifest.dependencies), ['mnemosy-ai'], 'Unexpected core dependency');
    if (lock.packages['node_modules/@huggingface/transformers']) fail('Core unexpectedly includes transformers');
  } else {
    if (manifest.dependencies['@huggingface/transformers'] !== '3.8.1' || lock.packages['node_modules/@huggingface/transformers']?.version !== '3.8.1' || lock.packages['node_modules/sharp']?.version !== '0.35.5') fail('Optional graph differs');
    same(manifest.overrides, { '@huggingface/transformers@3.8.1': { sharp: '0.35.5' } }, 'Optional override differs');
  }
  return { descriptor, manifest, lock };
}

export function bindConsumer({ profile, source, pack, tarball, templateDir = defaults }) {
  const { descriptor, manifest, lock } = loadTemplate(profile, templateDir);
  const sourceManifest = parse(read(source));
  same(contract(sourceManifest), descriptor.contract, 'Stale source dependency/peer/optional/package contract; reviewed template maintenance required');
  const packed = parse(read(pack));
  if (!Array.isArray(packed) || packed.length !== 1) fail('Expected exactly one npm pack result');
  const info = packed[0], bytes = read(tarball, 64 * 1024 * 1024);
  if (info.name !== sourceManifest.name || info.version !== sourceManifest.version || !/^[A-Za-z0-9_.-]+\.tgz$/.test(info.filename) || basename(tarball) !== info.filename) fail('Packed identity differs');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  if (info.integrity !== integrity || info.shasum !== createHash('sha1').update(bytes).digest('hex')) fail('Tarball differs from npm pack hashes');
  // Read ONLY the manifest to stdout, never extract archive paths to disk.
  // Feed the already hashed bytes, eliminating a second path-based tarball read.
  const extracted = spawnSync('tar', ['-xzOf', '-', 'package/package.json'], { input: bytes, timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (extracted.error || extracted.signal || extracted.status !== 0) fail('Cannot read bounded packed manifest');
  same(contract(parse(extracted.stdout)), descriptor.contract, 'Actual packed dependency/peer/optional/package contract differs');
  // The ONLY variable fields: three local references and the tarball integrity.
  manifest.dependencies['mnemosy-ai'] = 'file:artifact.tgz';
  lock.packages[''].dependencies['mnemosy-ai'] = 'file:artifact.tgz';
  lock.packages[localPath].resolved = 'file:artifact.tgz';
  lock.packages[localPath].integrity = integrity;
  if (registryHash(lock) !== descriptor.profiles[profile].registrySHA256) fail('Registry records changed during binding');
  return { manifest, lock, bytes, tarballSHA256: hash(bytes), registrySHA256: registryHash(lock) };
}

export function prepareConsumer(options) {
  const bound = bindConsumer(options);
  mkdirSync(options.install, { mode: 0o700 }); // Fresh directory only, no merging.
  writeFileSync(join(options.install, 'package.json'), JSON.stringify(bound.manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(options.install, 'package-lock.json'), JSON.stringify(bound.lock, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(options.install, 'artifact.tgz'), bound.bytes, { flag: 'wx', mode: 0o600 });
  return { profile: options.profile, tarballSHA256: bound.tarballSHA256, registrySHA256: bound.registrySHA256 };
}
export function checkConsumer(options) {
  const bound = bindConsumer(options);
  same(parse(read(join(options.install, 'package.json'))), bound.manifest, 'Consumer manifest drift');
  const actual = parse(read(join(options.install, 'package-lock.json')));
  validateClosure(actual);
  if (registryHash(actual) !== bound.registrySHA256) fail('Installed consumer registry-record drift');
  same(actual, bound.lock, 'Consumer lock drift');
  if (hash(read(join(options.install, 'artifact.tgz'), 64 * 1024 * 1024)) !== bound.tarballSHA256) fail('Isolated tarball copy differs');
  if (options.profile === 'optional') {
    const runtime = parse(read(join(options.install, 'node_modules/@huggingface/transformers/package.json')));
    if (runtime.version !== '3.8.1') fail('Optional consumer runtime missing or different');
  }
  // verify-package MUST run separately afterward: this metadata check does not
  // claim to verify installed exports/native runtime/demos or replace npm audit.
  return { profile: options.profile, tarballSHA256: bound.tarballSHA256, registrySHA256: bound.registrySHA256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { ...Object.fromEntries(['profile', 'source', 'pack', 'tarball', 'install'].map(name => [name, { type: 'string' }])), check: { type: 'boolean', default: false } }, strict: true, allowPositionals: false });
    if (['profile', 'source', 'pack', 'tarball', 'install'].some(name => !values[name])) fail('Expected --profile --source --pack --tarball --install [--check]');
    console.log(JSON.stringify(values.check ? checkConsumer(values) : prepareConsumer(values)));
  } catch (error) {
    console.error('Locked consumer check failed: ' + error.message);
    process.exitCode = 1;
  }
}
