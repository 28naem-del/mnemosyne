import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];
const setup = () => { const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-corpus-cli-')); directories.push(directory); return directory; };
const fixture = [{ question_id: 'q1', question_type: 'single-session-user', question: 'Where are the orchids?', question_date: '2024/01/10 (Wed) 12:00', answer: 'PRIVATE_GOLD_SENTINEL', answer_session_ids: ['s1'], haystack_session_ids: ['s1'], haystack_dates: ['2024/01/09 (Tue) 12:00'], haystack_sessions: [[{ role: 'user', content: 'The orchids are on the balcony.' }]] }];
const args = (source: string, output: string) => ['dist/evaluation/corpus-cli.js', '--format', 'longmemeval', '--file', source, '--out', output, '--dataset-revision', 'synthetic-v1', '--license', 'MIT'];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('standalone corpus benchmark CLI', () => {
  it('runs explicit source files offline, records their digest and generates a truthful index', () => {
    const directory = setup(), source = join(directory, 'synthetic.json'), output = join(directory, 'report.json'), index = join(directory, 'BENCHMARKS.md');
    const bytes = JSON.stringify(fixture); writeFileSync(source, bytes);
    const stdout = execFileSync(process.execPath, [...args(source, output), '--json', '{"includeBm25":true}'], { encoding: 'utf8', timeout: 15000 });
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.dataset.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(report.dataset.questions).toBe(1); expect(report.complete).toBe(true);
    expect(report.calls).toEqual({ embedding: 0, embeddingInputBytes: 0, generation: 0, judge: 0 });
    expect(report.summaries.bm25.allHitRate).toBe(1);
    expect(stdout + readFileSync(output, 'utf8')).not.toContain('PRIVATE_GOLD_SENTINEL');
    execFileSync(process.execPath, ['scripts/benchmark-index.mjs', '--out', index, output], { timeout: 15000 });
    const markdown = readFileSync(index, 'utf8');
    expect(markdown).toContain('[report.json](report.json) / bm25');
    expect(markdown).toContain('not generated-answer accuracy');
    expect(markdown).toContain('All evidence after packing');
    expect(markdown).toContain('1/1 (100.00%)');
    expect(markdown).toContain('Timestamp policy: strict-instant; 0 history sessions');
    expect(markdown).toContain(report.runtime.implementationSha256);
    execFileSync(process.execPath, ['scripts/benchmark-index.mjs', '--check', '--out', index, output], { timeout: 15000 });
    writeFileSync(index, markdown + '\nStale edit.\n');
    const stale = spawnSync(process.execPath, ['scripts/benchmark-index.mjs', '--check', '--out', index, output], { encoding: 'utf8', timeout: 15000 });
    expect(stale.status).toBe(1); expect(stale.stderr).toContain('Benchmark index is stale');
    expect(readFileSync(index, 'utf8')).toBe(markdown + '\nStale edit.\n');
  });
  it('refuses overwrites and symlink inputs while keeping private errors out of output', () => {
    const directory = setup(), source = join(directory, 'source.json'), output = join(directory, 'report.json'), link = join(directory, 'linked.json');
    writeFileSync(source, JSON.stringify(fixture)); writeFileSync(output, 'existing-report'); symlinkSync(source, link);
    const existing = spawnSync(process.execPath, args(source, output), { encoding: 'utf8', timeout: 15000 });
    expect(existing.status).toBe(1); expect(readFileSync(output, 'utf8')).toBe('existing-report');
    const linked = spawnSync(process.execPath, args(link, join(directory, 'new.json')), { encoding: 'utf8', timeout: 15000 });
    expect(linked.status).toBe(1); expect(linked.stderr).toContain('private error details omitted');
    expect(existing.stderr + linked.stderr).not.toContain('PRIVATE_GOLD_SENTINEL');
  });
  it('rejects unknown options and refuses to index reports that claim generated answer scores', () => {
    const directory = setup(), source = join(directory, 'source.json'), output = join(directory, 'report.json');
    writeFileSync(source, JSON.stringify(fixture));
    const invalid = spawnSync(process.execPath, [...args(source, output), '--json', '{"maxTokens":100}'], { encoding: 'utf8', timeout: 15000 });
    expect(invalid.status).toBe(1);
    writeFileSync(output, JSON.stringify({ kind: 'offline corpus retrieval evaluation', protocol: 'mnemosyne-corpus-retrieval-v1', answerQuality: 'perfect' }));
    const index = spawnSync(process.execPath, ['scripts/benchmark-index.mjs', '--out', join(directory, 'BENCHMARKS.md'), output], { encoding: 'utf8', timeout: 15000 });
    expect(index.status).toBe(1);
  });
});
