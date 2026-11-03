import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = process.env.WORKFLOW_SECURITY_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowRoot = join(root, '.github/workflows');
const workflows = readdirSync(workflowRoot).filter(name => name.endsWith('.yml'))
  .map(name => [name, readFileSync(join(workflowRoot, name), 'utf8')]);
const publish = readFileSync(join(workflowRoot, 'publish.yml'), 'utf8');

// These are targeted source contracts, not a replacement for YAML/actionlint or CI.
test('all workflow actions retain full SHA pins and checkout does not persist credentials', () => {
  for (const [name, source] of workflows) {
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const action = lines[i].match(/^\s*uses:\s+(\S+)/)?.[1];
      if (!action) continue;
      assert.match(action, /^[\w./-]+@[a-f0-9]{40}$/, name);
      if (action.startsWith('actions/checkout@')) {
        const end = lines.slice(i + 1).findIndex(line => /^      - /.test(line));
        const block = lines.slice(i + 1, end < 0 ? undefined : i + 1 + end).join('\n');
        assert.match(block, /^          persist-credentials: false$/m, name);
      }
    }
  }
});

test('cache and artifact jobs do not receive unnecessary actions write permission', () => {
  for (const [name, source] of workflows) assert.doesNotMatch(source, /^\s+actions: write$/m, name);
});

test('the SBOM checkout is bound to the source verified by the publish job', () => {
  const sbom = publish.split('  sbom:\n')[1];
  assert.ok(sbom);
  assert.ok(publish.includes('source-sha: ${{ steps.release.outputs.source-sha }}'));
  assert.ok(publish.includes("execFileSync('git', ['rev-parse', 'HEAD']"));
  assert.ok(publish.includes('source-sha=${sourceSha}\\n'));
  assert.ok(sbom.includes('ref: ${{ needs.publish.outputs.source-sha }}'));
  assert.ok(!sbom.includes('ref: refs/tags/'));
});

test('Scorecard has a bounded runtime and cancels only superseded runs of the same ref', () => {
  const source = readFileSync(join(workflowRoot, 'scorecard.yml'), 'utf8');
  assert.match(source, /^    timeout-minutes: 15$/m);
  assert.ok(source.includes('group: scorecard-${{ github.workflow }}-${{ github.ref }}'));
  assert.match(source, /^  cancel-in-progress: true$/m);
  assert.doesNotMatch(publish, /^  cancel-in-progress: true$/m, 'Do not cancel an in-flight release');
});

function attachmentScript() {
  const lines = publish.split('\n');
  const start = lines.findIndex(line => line === '      - name: Attach the SBOM to the GitHub release');
  assert.ok(start >= 0);
  const run = lines.findIndex((line, index) => index > start && line === '        run: |');
  assert.ok(run > start);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  assert.ok(body.length);
  return body.join('\n');
}

function attach(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-sbom-workflow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.log');
  writeFileSync(log, '');
  const mock = `gh() {
printf '%s\n' "$*" >> "$CALL_LOG"
case "$1" in
  api)
    [ "$MODE" = api-failure ] && return 42
    printf '%s\n' v9.0.0
    [ "$MODE" != absent ] && printf '%s\n' "$RELEASE_TAG"
    return 0;;
  release)
    if [ "$2" = view ]; then
      [ "$MODE" = api-failure ] && return 42
      [ "$MODE" = absent ] && return 1
      return 0
    fi
    [ "$2" = upload ] || return 43
    [ "$MODE" = upload-failure ] && return 44
    return 0;;
  *) return 45;;
esac
}
`;
  const result = spawnSync('bash', ['-c', mock + attachmentScript()], {
    encoding: 'utf8', cwd: directory,
    env: { ...process.env, MODE: mode, CALL_LOG: log,
      GITHUB_REPOSITORY: 'example/memory', RELEASE_TAG: 'v1.2.3', ASSET: 'mnemosy-ai-1.2.3.cdx.json', GH_TOKEN: '' },
  });
  assert.ifError(result.error);
  return { ...result, calls: readFileSync(log, 'utf8') };
}

test('an absent release retains the artifact and emits a warning without uploading', t => {
  const result = attach(t, 'absent');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning::No GitHub Release/);
  assert.doesNotMatch(result.calls, /release upload/);
  assert.match(result.calls, /api --paginate repos\/example\/memory\/releases --jq/);
});

test('an existing release receives the exact versioned SBOM asset', t => {
  const result = attach(t, 'present');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /release upload v1\.2\.3 mnemosy-ai-1\.2\.3\.cdx\.json --clobber --repo example\/memory/);
});

test('API or authentication failure fails closed instead of claiming no release exists', t => {
  const result = attach(t, 'api-failure');
  assert.equal(result.status, 42, result.stderr);
  assert.doesNotMatch(result.stdout, /No GitHub Release/);
  assert.doesNotMatch(result.calls, /release upload/);
});

test('SBOM upload errors remain failures', t => {
  const result = attach(t, 'upload-failure');
  assert.equal(result.status, 44, result.stderr);
});
