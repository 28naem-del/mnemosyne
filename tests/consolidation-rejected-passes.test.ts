import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectRejectedPasses, receiptProblem, rejectedPassLineProblem, summarizeRejectedPasses, verifyRejectedPasses, type RejectedPassLine } from '../src/consolidation/rejected-passes.js';

/**
 * The published rejected-passes artifact: every pass the gate rolled back in
 * the demo and in the poisoning suite's consolidation mode, each line carrying
 * a receipt that still verifies offline.
 */

const read = (path: string): string => readFileSync(resolve(path), 'utf8');
const SUITE = 'reports/poisoning/v1-consolidation/rejected-passes.jsonl';
const published = (): RejectedPassLine[] => read('reports/consolidation/rejected-passes.jsonl').split('\n').filter(Boolean).map((line) => JSON.parse(line) as RejectedPassLine);

describe('reports/consolidation/rejected-passes.jsonl', () => {
  it('verifies every line and includes a regression and an untrusted-to-policy laundering rollback, each with its receipt', () => {
    const lines = published();
    for (const line of lines) {
      expect(receiptProblem(line.receipt), line.passId).toBeNull();
      expect(line).toMatchObject({ verdict: 'rolled_back', passId: line.receipt.passId, digest: line.receipt.digest, prevDigest: line.receipt.prevDigest, reason: line.receipt.reason });
      expect(line.receipt).toMatchObject({ action: 'gate', verdict: 'rolled_back' });
    }
    const regression = lines.find((line) => line.rejection === 'regression')!;
    expect(regression).toMatchObject({ source: 'consolidation-demo', laundering: false, failedInvariants: [] });
    expect(regression.reason).toMatch(/^regression: proposal 1 alone delta -1/);
    expect(regression.perProposal.some((delta) => delta < 0)).toBe(true);
    const laundering = lines.filter((line) => line.laundering);
    expect(laundering.some((line) => line.source === 'consolidation-demo')).toBe(true);
    for (const line of laundering) expect(line.failedInvariants).toContain('no-untrusted-to-policy');
  });

  it('carries exactly the suite run\'s rejected passes, in order, and a summary that matches the lines', () => {
    const lines = published();
    const suite = read(SUITE).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { passId: string; digest: string; caseId: string });
    expect(lines.filter((line) => line.source === 'poisoning-suite-v1-consolidation').map(({ passId, digest, caseId }) => ({ passId, digest, caseId })))
      .toEqual(suite.map(({ passId, digest, caseId }) => ({ passId, digest, caseId })));
    const summary = JSON.parse(read('reports/consolidation/rejected-passes.summary.json'));
    expect(summary).toEqual(summarizeRejectedPasses(lines, summary.command));
    expect(summary.command).toBe(`node dist/consolidation/rejected-passes.js --suite ${SUITE} --out reports/consolidation`);
  });

  it('binds every line field derived from the receipt, so an edit outside the receipt is caught too', () => {
    const lines = published();
    expect(verifyRejectedPasses(read('reports/consolidation/rejected-passes.jsonl'))).toEqual({ lines: lines.length, problems: [] });
    const edited = structuredClone(lines[3]);
    edited.reason = 'kept: looks fine';
    edited.delta = 99;
    expect(rejectedPassLineProblem(edited)).toBe('line field(s) reason, delta do not match the receipt');
    const extra = { ...structuredClone(lines[3]), verdict: 'kept' } as unknown as RejectedPassLine;
    expect(rejectedPassLineProblem(extra)).toMatch(/verdict/);
    const report = verifyRejectedPasses(lines.map((line, index) => JSON.stringify(index === 3 ? edited : line)).join('\n'));
    expect(report.problems).toEqual([{ line: 4, problem: 'line field(s) reason, delta do not match the receipt' }]);
  });

  it('refuses to publish a suite line whose receipt was edited', () => {
    const [first, ...rest] = read(SUITE).split('\n').filter(Boolean);
    const edited = JSON.parse(first);
    edited.receipt.reason = 'kept by hand';
    expect(() => collectRejectedPasses([JSON.stringify(edited), ...rest].join('\n'))).toThrow(/suite line 1: .*digest does not match/);
    const regenerated = collectRejectedPasses(read(SUITE));
    expect(regenerated.map(({ source, rejection, laundering, reason, delta, holdoutDelta, perProposal }) => ({ source, rejection, laundering, reason, delta, holdoutDelta, perProposal })))
      .toEqual(published().map(({ source, rejection, laundering, reason, delta, holdoutDelta, perProposal }) => ({ source, rejection, laundering, reason, delta, holdoutDelta, perProposal })));
  });
});
