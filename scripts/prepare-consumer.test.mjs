import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bindConsumer, checkConsumer, hash, loadTemplate, prepareConsumer, registryHash, registryRecords, validateClosure } from './prepare-consumer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const templates = join(root, 'scripts/consumer-locks');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'locked-consumer-unit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.json'), staging = join(directory, 'staging');
  const manifest = json(join(root, 'package.json'));
  save(source, manifest); mkdirSync(join(staging, 'package'), { recursive: true });
  const tarball = join(directory, 'mnemosy-ai-' + manifest.version + '.tgz'), pack = join(directory, 'pack.json');
  // Real tar/gzip bytes with unit-only contents, NOT a built release/install.
  // Registry metadata is always the genuine approved npm-generated templates.
  const archive = (packedManifest = manifest) => {
    save(join(staging, 'package/package.json'), packedManifest);
    const result = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const bytes = readFileSync(tarball);
    save(pack, [{ name: manifest.name, version: manifest.version, filename: 'mnemosy-ai-' + manifest.version + '.tgz',
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), shasum: createHash('sha1').update(bytes).digest('hex') }]);
  };
  archive();
  return { directory, manifest, archive, options: { profile: 'core', source, pack, tarball, install: join(directory, 'consumer') } };
}

for (const profile of ['core', 'optional']) {
  test(profile + ' authoritative template validates hashes and full optional/platform edge closure', () => {
    const { descriptor, lock } = loadTemplate(profile);
    assert.equal(Object.keys(lock.packages).length, profile === 'core' ? 33 : 103);
    assert.equal(validateClosure(lock), descriptor.profiles[profile].closureEdges);
    assert.equal(registryHash(lock), descriptor.profiles[profile].registrySHA256);
    assert.equal(lock.packages['node_modules/hnswlib-node'].version, '3.0.0');
    assert.equal(lock.packages['node_modules/sqlite-vec-linux-arm64'].version, '0.1.9');
  });
  test(profile + ' binding changes only three local references and current tarball integrity', t => {
    const f = fixture(t), before = loadTemplate(profile), after = bindConsumer({ ...f.options, profile });
    assert.deepEqual(registryRecords(after.lock), registryRecords(before.lock));
    const restored = structuredClone(after.lock);
    restored.packages[''].dependencies['mnemosy-ai'] = before.lock.packages[''].dependencies['mnemosy-ai'];
    restored.packages['node_modules/mnemosy-ai'].resolved = before.lock.packages['node_modules/mnemosy-ai'].resolved;
    restored.packages['node_modules/mnemosy-ai'].integrity = before.lock.packages['node_modules/mnemosy-ai'].integrity;
    assert.deepEqual(restored, before.lock);
    const restoredManifest = structuredClone(after.manifest);
    restoredManifest.dependencies['mnemosy-ai'] = before.manifest.dependencies['mnemosy-ai'];
    assert.deepEqual(restoredManifest, before.manifest);
    assert.equal(after.lock.packages['node_modules/mnemosy-ai'].integrity, json(f.options.pack)[0].integrity);
  });
}

test('prepared manifests/locks/tarball bytes are identical across independent fresh directories', t => {
  const f = fixture(t), second = { ...f.options, install: join(f.directory, 'second') };
  prepareConsumer(f.options); prepareConsumer(second);
  assert.deepEqual(readdirSync(f.options.install).sort(), ['artifact.tgz', 'package-lock.json', 'package.json']);
  for (const file of ['package.json', 'package-lock.json', 'artifact.tgz']) assert.deepEqual(readFileSync(join(f.options.install, file)), readFileSync(join(second.install, file)));
  assert.equal(checkConsumer(f.options).tarballSHA256, hash(readFileSync(f.options.tarball))); // metadata check only; NOT an installed release claim.
  assert.throws(() => prepareConsumer(f.options), /EEXIST/);
});

for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundledDependencies', 'version']) {
  test('rejects stale source ' + field + ' without resolving new ranges', t => {
    const f = fixture(t); f.manifest[field] = field === 'version' ? '99.0.0' : {};
    save(f.options.source, f.manifest);
    assert.throws(() => bindConsumer(f.options), /Stale source/);
  });
}

test('rejects tarball mismatch even when filename and package identity remain unchanged', t => {
  const f = fixture(t); writeFileSync(f.options.tarball, 'different packed bytes');
  assert.throws(() => bindConsumer(f.options), /npm pack hashes/);
});
test('valid hashes cannot hide different dependency metadata inside actual tarball manifest', t => {
  const f = fixture(t); const changed = structuredClone(f.manifest); changed.optionalDependencies = {};
  f.archive(changed); // Pack hashes correctly describe these changed archive bytes.
  assert.throws(() => bindConsumer(f.options), /Actual packed dependency/);
});
test('rejects pack identity or integrity drift', t => {
  const f = fixture(t), pack = json(f.options.pack); pack[0].name = 'other-package'; save(f.options.pack, pack);
  assert.throws(() => bindConsumer(f.options), /identity/);
  pack[0].name = f.manifest.name; pack[0].integrity = 'sha512-invalid'; save(f.options.pack, pack);
  assert.throws(() => bindConsumer(f.options), /npm pack hashes/);
});

test('missing required transitive dependency is a real closure failure', () => {
  const { lock } = loadTemplate('core'); delete lock.packages['node_modules/zod'];
  assert.throws(() => validateClosure(lock), /Missing locked dependency zod/);
});
test('optional platform records cannot be pruned from the reviewed lock', () => {
  const { lock } = loadTemplate('optional'); delete lock.packages['node_modules/@img/sharp-linux-x64'];
  assert.throws(() => validateClosure(lock), /Missing locked dependency @img\/sharp-linux-x64/);
});
test('missing optional peer is allowed, required peer is not silently skipped', () => {
  const { lock } = loadTemplate('core'); assert.ok(validateClosure(lock) > 0);
  lock.packages['node_modules/mnemosy-ai'].peerDependenciesMeta.ioredis.optional = false;
  assert.throws(() => validateClosure(lock), /Missing locked dependency ioredis/);
});
test('registry integrity, resolution and workspace/path failures are rejected', () => {
  for (const mutate of [lock => { delete lock.packages['node_modules/zod'].integrity; }, lock => { lock.packages['node_modules/zod'].resolved = 'http://registry.npmjs.org/zod.tgz'; }, lock => { lock.packages['node_modules/zod'].link = true; }, lock => { lock.packages['../escape'] = lock.packages['node_modules/zod']; }]) {
    const { lock } = loadTemplate('core'); mutate(lock); assert.throws(() => validateClosure(lock));
  }
});

test('template byte tampering and even rehashed registry drift are rejected separately', t => {
  const f = fixture(t), copy = join(f.directory, 'templates'); cpSync(templates, copy, { recursive: true });
  const path = join(copy, 'core/package-lock.json'), lock = json(path); lock.packages['node_modules/zod'].version = '99.0.0'; save(path, lock);
  assert.throws(() => loadTemplate('core', copy), /Template tamper/);
  const descriptorPath = join(copy, 'templates.json'), descriptor = json(descriptorPath);
  descriptor.profiles.core.files['package-lock.json'] = hash(readFileSync(path)); save(descriptorPath, descriptor);
  assert.throws(() => loadTemplate('core', copy), /Registry template drift/);
});

test('post-ci metadata check rejects registry drift, local receipt drift and copied-tarball tampering', t => {
  const f = fixture(t); prepareConsumer(f.options);
  const path = join(f.options.install, 'package-lock.json'), original = json(path), changed = structuredClone(original);
  changed.packages['node_modules/zod'].version = '99.0.0'; save(path, changed);
  assert.throws(() => checkConsumer(f.options), /registry-record drift/);
  const receipt = structuredClone(original); receipt.packages['node_modules/mnemosy-ai'].integrity = 'wrong'; save(path, receipt);
  assert.throws(() => checkConsumer(f.options), /Consumer lock drift/);
  save(path, original); writeFileSync(join(f.options.install, 'artifact.tgz'), 'different bytes');
  assert.throws(() => checkConsumer(f.options), /tarball copy differs/);
});
test('optional post-ci check cannot succeed with only a lock but no installed runtime', t => {
  const f = fixture(t), options = { ...f.options, profile: 'optional' }; prepareConsumer(options);
  assert.throws(() => checkConsumer(options), /ENOENT/);
});
test('actual CLI prepares and checks metadata without npm/network/resolution', t => {
  const f = fixture(t), cli = join(root, 'scripts/prepare-consumer.mjs');
  const args = ['--profile', 'core', '--source', f.options.source, '--pack', f.options.pack, '--tarball', f.options.tarball, '--install', f.options.install];
  for (const extra of [[], ['--check']]) {const result = spawnSync(process.execPath, [cli, ...args, ...extra], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).profile, 'core');}
});

const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const publish = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8');
function step(source, name) { return source.split('      - name: ' + name + '\n')[1]?.split('\n      - name: ')[0]; }
function shell(body) {
  const lines = [];
  for (const line of body.split('        run: |\n')[1].split('\n')) {
    if (line && !line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  return lines.join('\n');
}

test('CI uses independent locked core/optional installs and preserves real audit/artifact coverage', () => {
  const body = step(ci, 'Check the installed release artifact');
  assert.ok(body.includes('for PROFILE in core optional; do'));
  assert.ok(body.includes('MNEMOSYNE_SMOKE_DIR="$MNEMOSYNE_SMOKE_ROOT/$PROFILE"'));
  assert.ok(body.includes('npm ci --prefix "$MNEMOSYNE_SMOKE_DIR" --ignore-scripts --omit=dev --include=optional --no-audit --no-fund'));
  assert.ok(body.indexOf('node scripts/prepare-consumer.mjs --profile') < body.indexOf('npm ci --prefix'));
  assert.ok(body.indexOf('npm ci --prefix') < body.indexOf('node scripts/prepare-consumer.mjs --check'));
  assert.ok(body.includes('npm audit --prefix "$MNEMOSYNE_SMOKE_DIR" --omit=dev --audit-level=high'));
  assert.ok(body.indexOf('node scripts/verify-package.mjs') > body.indexOf('npm audit --prefix'));
  assert.ok(body.includes('--tarball "$PWD/$PACK_NAME"'));
  assert.doesNotMatch(body, /npm install|--omit=optional|package-lock-only|continue-on-error/);
});
test('publish uses the same locked core binder and still publishes the checked original filename', () => {
  const body = step(publish, 'Build and verify the publication artifact');
  for (const token of ['--profile core', 'npm ci --prefix', '--include=optional', 'node scripts/prepare-consumer.mjs --check', 'node scripts/verify-package.mjs', '--tarball "$PWD/$PACK_NAME"', "printf 'filename=%s"]) assert.ok(body.includes(token), token);
  assert.ok(publish.includes('run: npm publish "$PACK_FILE" --tag "$NPM_DIST_TAG" --access public --provenance'));
  assert.ok(publish.includes('PACK_FILE: $' + '{{ steps.package.outputs.filename }}'));
  assert.doesNotMatch(body, /npm install|package-lock-only/);
});
test('temporary bootstrap capture/export/code is removed, Docker smoke remains real and bounded', () => {
  assert.doesNotMatch(ci, /CAPTURE_CONSUMER_LOCKS|capture-consumer-locks|consumer-lock-bootstrap|Export temporary/);
  for (const file of ['capture-consumer-locks.mjs', 'capture-consumer-locks.test.mjs']) assert.equal(existsSync(join(root, 'scripts', file)), false);
  const body = step(ci, 'Build and smoke-test the pinned Docker image');
  for (const token of ["if: matrix.node == '24'", 'timeout-minutes: 7', '300s docker build --pull', '30s docker run', '--network none --read-only', 'mnemosyne-ci-smoke --version', 'mnemosyne-ci-smoke --help', 'test "$ACTUAL_VERSION" = "$EXPECTED_VERSION"', 'docker rm --force']) assert.ok(body.includes(token), token);
  assert.doesNotMatch(body, /docker (?:push|login)|--entrypoint|continue-on-error/);
});
test('actual bash syntax validation covers both consumer workflows and Docker smoke', () => {
  for (const [source, name] of [[ci, 'Check the installed release artifact'], [publish, 'Build and verify the publication artifact'], [ci, 'Build and smoke-test the pinned Docker image']]) {
    const result = spawnSync('bash', ['-n'], { input: shell(step(source, name)), encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
});
