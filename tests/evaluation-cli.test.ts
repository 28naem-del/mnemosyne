import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const fixture = [{ question_id: 'cli-fixture', question_type: 'single-session-user', question: 'What color is the orchid?', question_date: '2026-09-12T12:00:00Z', answer: 'REFERENCE_ANSWER_NOT_FOR_INDEX', haystack_session_ids: ['evidence'], haystack_dates: ['2026-09-11T12:00:00Z'], haystack_sessions: [[{ role: 'user', content: 'The orchid is violet.' }]], answer_session_ids: ['evidence'] }];
const run = (...args: string[]) => execFileSync(process.execPath, [resolve('dist/cli/index.js'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
function inputFile() {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-evaluation-cli-')); roots.push(root);
  const input = join(root, 'fixture.json'); writeFileSync(input, JSON.stringify(fixture));
  return { root, input };
}

describe('offline evaluation CLI', () => {
  it('evaluates a supplied fixture with no provider or live memory scope', () => {
    const { input } = inputFile();
    const report = JSON.parse(run('evaluate', '--file', input, '--limit', '3'));
    expect(report).toMatchObject({ kind: 'LongMemEval-style offline retrieval evaluation', topK: 3, providerMode: 'none', calls: { embedding: 0, generation: 0, judge: 0 }, answerQuality: { status: 'not-evaluated', abstentionAccuracy: null } });
    expect(report.summary.lexical.all.meanEvidenceSessionRecall).toBe(1);
    expect(report.summary['no-memory'].all.meanEvidenceSessionRecall).toBe(0);
    expect(JSON.stringify(report)).not.toContain(fixture[0].answer);
  });

  it('writes a private report and refuses to replace an existing output', () => {
    const { root, input } = inputFile(); const out = join(root, 'report.json');
    expect(JSON.parse(run('evaluate', '--file', input, '--out', out)).questions).toBe(1);
    const original = readFileSync(out, 'utf8');
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(() => run('evaluate', '--file', input, '--out', out)).toThrow();
    expect(readFileSync(out, 'utf8')).toBe(original);
    expect(() => run('evaluate', '--file', input, '--json', '{"embedder":{}}')).toThrow();
  });
});
