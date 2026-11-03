import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { captureConsumer } from './capture-consumer-locks.mjs';

const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
// Synthetic unit fixtures ONLY: no install/audit/build is simulated or claimed.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'consumer-capture-unit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const install = join(directory, 'consumer'); mkdirSync(install);
  const tarball = join(directory, 'mnemosy-ai-1.0.0.tgz'), bytes = Buffer.from('synthetic unit fixture, not an npm release');
  writeFileSync(tarball, bytes);
  const info = { name: 'mnemosy-ai', version: '1.0.0', filename: 'mnemosy-ai-1.0.0.tgz', integrity: 'sha512-' + hash(bytes, 'sha512', 'base64'), shasum: hash(bytes, 'sha1') };
  const source = join(directory, 'source.json'), pack = join(directory, 'pack.json');
  save(source, { name: info.name, version: info.version, dependencies: { zod: '^4.6.7' }, optionalDependencies: { 'sqlite-vec': '^0.1.9' } }); save(pack, [info]);
  const manifest = { dependencies: { 'mnemosy-ai': 'file:../' + info.filename } };
  const registry = (name, version) => ({ version, resolved: 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + version + '.tgz', integrity: 'sha512-unit-fixture-only' });
  const lock = { lockfileVersion: 3, packages: { '': structuredClone(manifest), 'node_modules/mnemosy-ai': { ...json(source), resolved: manifest.dependencies['mnemosy-ai'], integrity: info.integrity }, 'node_modules/zod': registry('zod', '4.6.7'), 'node_modules/sqlite-vec': { ...registry('sqlite-vec', '0.1.9'), optional: true } } };
  save(join(install, 'package.json'), manifest); save(join(install, 'package-lock.json'), lock);
  // Files that must NEVER enter the artifact.
  writeFileSync(join(install, '.npmrc'), 'UNIT_SENTINEL_DO_NOT_EXPORT');
  mkdirSync(join(install, 'node_modules')); writeFileSync(join(install, 'node_modules/unrelated'), 'UNIT_SENTINEL_DO_NOT_EXPORT');
  const options = { profile: 'core', source, pack, install, tarball, out: join(directory, 'out'), metadata: { sourceSHA: 'a'.repeat(40), node: 'v24.20.0', npm: '11.19.0' } };
  const optional = () => {
    manifest.dependencies['@huggingface/transformers'] = '3.8.1';
    manifest.overrides = { '@huggingface/transformers@3.8.1': { sharp: '0.35.5' } };
    lock.packages[''].dependencies = structuredClone(manifest.dependencies);
    lock.packages['node_modules/@huggingface/transformers'] = registry('transformers', '3.8.1');
    lock.packages['node_modules/sharp'] = registry('sharp', '0.35.5');
    save(join(install, 'package.json'), manifest); save(join(install, 'package-lock.json'), lock);
    return { ...options, profile: 'optional' };
  };
  return { options, info, manifest, lock, optional };
}

test('capture preserves exact real-input bytes and emits only four allowlisted files', t => {
  const { options } = fixture(t), provenance = captureConsumer(options), directory = join(options.out, 'core');
  assert.deepEqual(readdirSync(directory).sort(), ['pack.json', 'package-lock.json', 'package.json', 'provenance.json']);
  for (const [name, input] of [['package.json', join(options.install, 'package.json')], ['package-lock.json', join(options.install, 'package-lock.json')], ['pack.json', options.pack]]) assert.deepEqual(readFileSync(join(directory, name)), readFileSync(input));
  assert.equal(provenance.sourceSHA, options.metadata.sourceSHA);
  assert.equal(provenance.tarball.sha256, hash(readFileSync(options.tarball)));
  for (const entry of provenance.files) assert.equal(entry.sha256, hash(readFileSync(join(directory, entry.path))));
  assert.ok(!JSON.stringify(provenance).includes('UNIT_SENTINEL'));
});

test('core snapshot survives optional mutation and both profiles bind identical packed bytes', t => {
  const f = fixture(t), core = captureConsumer(f.options), coreBytes = readFileSync(join(f.options.out, 'core/package-lock.json'));
  const optional = captureConsumer(f.optional());
  assert.deepEqual(readFileSync(join(f.options.out, 'core/package-lock.json')), coreBytes);
  assert.equal(optional.tarball.sha256, core.tarball.sha256);
  assert.equal(json(join(f.options.out, 'optional/package.json')).overrides['@huggingface/transformers@3.8.1'].sharp, '0.35.5');
  assert.equal(json(join(f.options.out, 'optional/package-lock.json')).packages['node_modules/sharp'].version, '0.35.5');
});

for (const [label, mutate, pattern] of [
  ['tarball tampering', f => writeFileSync(f.options.tarball, 'different bytes'), /Tarball bytes/],
  ['pack identity drift', f => { const p = json(f.options.pack); p[0].version = '9.0.0'; save(f.options.pack, p); }, /identity/],
  ['receipt integrity drift', f => { f.lock.packages['node_modules/mnemosy-ai'].integrity = 'wrong'; }, /bind/],
  ['root dependency drift', f => { f.lock.packages[''].dependencies = {}; }, /roots disagree/],
  ['stale optional metadata', f => { delete f.lock.packages['node_modules/mnemosy-ai'].optionalDependencies; }, /source optionalDependencies/],
  ['registry integrity missing', f => { delete f.lock.packages['node_modules/zod'].integrity; }, /Incomplete registry/],
  ['credential-bearing URL', f => { f.lock.packages['node_modules/zod'].resolved = 'https://user:password@registry.npmjs.org/zod.tgz'; }, /credential-bearing/],
  ['nonlocal release dependency', f => { f.manifest.dependencies['mnemosy-ai'] = '^1.0.0'; save(join(f.options.install, 'package.json'), f.manifest); }, /local tarball/],
]) {
  test('capture fails closed for ' + label, t => {
    const f = fixture(t); mutate(f); save(join(f.options.install, 'package-lock.json'), f.lock);
    assert.throws(() => captureConsumer(f.options), pattern);
  });
}

test('capture refuses duplicate outputs and symlink evidence inputs', t => {
  const { options } = fixture(t); captureConsumer(options);
  assert.throws(() => captureConsumer(options), /EEXIST/);
  const alias = join(options.install, 'alias.json'); symlinkSync(options.pack, alias);
  assert.throws(() => captureConsumer({ ...options, pack: alias }), /regular evidence input/);
});

test('optional capture rejects missing override, missing runtime and mismatched source provenance', t => {
  const f = fixture(t); captureConsumer(f.options); const options = f.optional();
  delete f.manifest.overrides; save(join(options.install, 'package.json'), f.manifest);
  assert.throws(() => captureConsumer(options), /Optional runtime/);
  f.manifest.overrides = { '@huggingface/transformers@3.8.1': { sharp: '0.35.5' } }; save(join(options.install, 'package.json'), f.manifest);
  delete f.lock.packages['node_modules/@huggingface/transformers']; save(join(options.install, 'package-lock.json'), f.lock);
  assert.throws(() => captureConsumer(options), /Optional runtime/);
  const restored = f.optional();
  assert.throws(() => captureConsumer({ ...restored, metadata: { ...restored.metadata, sourceSHA: 'b'.repeat(40) } }), /same source/);
});

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
function step(name) { return ci.split('      - name: ' + name + '\n')[1]?.split('\n      - name: ')[0]; }
function shell(name) { return step(name).split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n'); }

test('temporary capture is PR/Node24 only and preserves existing installs, audits and verifier order', () => {
  const body = step('Check the installed release artifact');
  assert.ok(body.includes("CAPTURE_CONSUMER_LOCKS: $" + "{{ matrix.node == '24' && github.event_name == 'pull_request' }}"));
  assert.equal((body.match(/if \[ "\$CAPTURE_CONSUMER_LOCKS" = true \]; then/g) ?? []).length, 2);
  const core = body.indexOf('--profile core'), mutation = body.indexOf("manifest.dependencies['@huggingface/transformers']"), optional = body.indexOf('--profile optional');
  const installs = [...body.matchAll(/^          npm install .+$/gm)].map(match => match[0].trim());
  assert.deepEqual(installs, ['npm install --prefix "$MNEMOSYNE_SMOKE_DIR" --ignore-scripts --omit=dev --no-audit --no-fund "$PWD/$PACK_NAME"', 'npm install --prefix "$MNEMOSYNE_SMOKE_DIR" --ignore-scripts --omit=dev --no-audit --no-fund']);
  assert.ok(body.indexOf('node scripts/verify-package.mjs') < core && core < mutation && mutation < optional);
  assert.ok(body.includes("'@huggingface/transformers@3.8.1': { sharp: '0.35.5' }"));
  assert.ok(body.indexOf('npm audit --prefix "$MNEMOSYNE_SMOKE_DIR" --omit=dev --audit-level=high') < optional);
  assert.equal((body.match(/node scripts\/verify-package\.mjs/g) ?? []).length, 2);
  assert.ok(body.lastIndexOf('node scripts/verify-package.mjs') < optional);
});

test('artifact uses an existing pinned action and exports exactly the eight bounded evidence paths', () => {
  const body = step('Export temporary consumer lock bootstrap evidence');
  assert.ok(body.includes("if: matrix.node == '24' && github.event_name == 'pull_request'"));
  const action = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9';
  assert.ok(body.includes('uses: ' + action));
  assert.ok(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8').includes('uses: ' + action));
  const paths = body.split('          path: |\n')[1].split('          if-no-files-found:')[0].trim().split('\n').map(line => line.trim());
  assert.deepEqual(paths, ['core', 'optional'].flatMap(profile => ['package.json', 'package-lock.json', 'pack.json', 'provenance.json'].map(file => '$' + '{{ runner.temp }}/mnemosyne-consumer-lock-evidence/' + profile + '/' + file)));
  assert.ok(body.includes('if-no-files-found: error') && body.includes('retention-days: 7'));
  assert.ok(!body.includes('always()'));
});

test('Docker CI builds actual pinned image and bounds offline CLI entrypoint smoke without a push', () => {
  const body = step('Build and smoke-test the pinned Docker image');
  assert.ok(body.includes("if: matrix.node == '24'"));
  assert.ok(body.includes('timeout-minutes: 7'));
  assert.ok(body.includes('timeout --kill-after=15s 300s docker build --pull --tag mnemosyne-ci-smoke .'));
  assert.ok(body.includes('docker run --rm --network none --read-only --name mnemosyne-ci-version mnemosyne-ci-smoke --version'));
  assert.ok(body.includes('docker run --rm --network none --read-only --name mnemosyne-ci-help mnemosyne-ci-smoke --help'));
  assert.ok(body.includes('test "$ACTUAL_VERSION" = "$EXPECTED_VERSION"'));
  assert.ok(body.includes('docker rm --force mnemosyne-ci-version mnemosyne-ci-help'));
  assert.ok(!/docker (?:push|login)|--entrypoint|continue-on-error/.test(body));
});

test('both changed workflow run blocks pass actual bash syntax checking', () => {
  for (const name of ['Check the installed release artifact', 'Build and smoke-test the pinned Docker image']) {
    const result = spawnSync('bash', ['-n'], { input: shell(name), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
