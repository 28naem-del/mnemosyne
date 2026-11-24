import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BISECT_HYBRID_RECORDS, BISECT_HYBRID_SEED, HASHED_EMBEDDER_MODEL, runHybridBisectCase, type HybridBisectCaseResult } from '../src/evaluation/bisect-hybrid.js';

/**
 * The seeded 2,000-record bisect case on the hybrid path.
 *
 * Moment 3 of the demo proves blame precision 1.00 on 2,000 records on the
 * zero-model lexical path. This is the same store retrieving on `hybrid`
 * (dense and lexical fused, the dense channel served by the exact scan or by
 * sqlite-vec), with Oracle B re-executing that hybrid retriever. It runs with a
 * deterministic hashed embedder, so it needs no model and runs on every CI
 * host. `reports/bisect-hybrid-2k.json` is the committed run the published
 * figures come from; the last case pins that it still matches what the code
 * does.
 */

const INDEXES = ['exact', 'sqlite-vec'] as const;
const runs = new Map<string, HybridBisectCaseResult>();
const run = (indexMode: typeof INDEXES[number]): HybridBisectCaseResult => {
  if (!runs.has(indexMode)) runs.set(indexMode, runHybridBisectCase({ indexMode }));
  return runs.get(indexMode)!;
};

describe('bisect on a 2,000-record seeded hybrid store', { timeout: 120_000 }, () => {
  for (const indexMode of INDEXES) {
    it(`isolates the seeded record with precision 1.00 (${indexMode} index)`, () => {
      const result = run(indexMode);
      expect(result.records).toBeGreaterThanOrEqual(2000);
      // The failure has to be real, or isolating it proves nothing: the gold
      // answered before the false record arrived, and the false record answers now.
      expect(result.passedBefore).toBe(true);
      expect(result.failingAfter).toBe(true);
      expect(result.outcome).toBe('blamed');
      expect(result.reason).toBe('displaced');
      expect(result.blame).toBe(1);
      expect(result.precision).toBe(1);
      expect(result.exact).toBe(true);
      expect(result.goldRank).toBe(2);
      // Oracle B re-ran the hybrid retriever the store runs, on the same dense index.
      expect(result.exactConfirmed).toBe(true);
      expect(result.exactRetrieval).toBe('hybrid');
      expect(result.exactConfig).toMatchObject({ mode: 'hybrid', embeddingModel: HASHED_EMBEDDER_MODEL, rerankerModel: null, index: indexMode });
      // Every rebuild carried the stored vectors; no passage was embedded again.
      expect(result.reembeddedPassages).toBe(0);
      // The same bar as moment 3; measured well under it.
      expect(result.bisectSeconds).toBeLessThan(60);
    });
  }

  it('matches the committed report, field for field except the timings', () => {
    const report = JSON.parse(readFileSync('reports/bisect-hybrid-2k.json', 'utf8')) as {
      seed: number; records: number; cases: (HybridBisectCaseResult & Record<string, unknown>)[];
    };
    expect(report.seed).toBe(BISECT_HYBRID_SEED);
    expect(report.records).toBe(BISECT_HYBRID_RECORDS);
    expect(report.cases.map(entry => entry.indexRequested)).toEqual([...INDEXES]);
    for (const recorded of report.cases) {
      const { bisectSeconds: _b, totalSeconds: _t, ...measured } = run(recorded.indexRequested);
      const { bisectSeconds, totalSeconds, ...stable } = recorded;
      expect(stable).toEqual(measured);
      expect(bisectSeconds).toBeGreaterThan(0);
      expect(totalSeconds).toBeGreaterThanOrEqual(bisectSeconds);
    }
  });
});
