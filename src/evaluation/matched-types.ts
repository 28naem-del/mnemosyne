/**
 * The matched-run contract.
 *
 * A matched run scores several memory systems on one corpus under one scorer.
 * The only thing that differs between systems is which passages come back for a
 * query; chunking, the context envelope, the packing budget and the evidence
 * scorer are the same code for every system, in the same loop, in
 * `runCorpusBenchmark`. That is what makes the resulting table a comparison
 * rather than a collection of separately-reported numbers.
 *
 * An adapter therefore receives the *least* information that still lets it do
 * its job: chunk identity and chunk text, then a query string and a limit. It
 * never sees an evidence group, an answerability label, a question id, a
 * category, a reference answer, or the name of the condition it is running as.
 * `tests/matched-systems.test.ts` asserts that boundary rather than trusting it.
 */

/** One indexable unit, identical in text and identity for every system. */
export interface MatchedChunk {
  id: string;
  text: string;
  role?: 'user' | 'assistant';
  speaker?: string;
  date?: string;
}

/** One isolated instance of a competitor system, holding one corpus. */
export interface MatchedSession {
  /** Load the corpus. Called once, with every chunk, before any retrieval. */
  ingest(chunks: MatchedChunk[], operation: { signal: AbortSignal }): Promise<void>;
  /** Rank chunk identities for a query, best first. Unknown identities are an error. */
  retrieve(request: { query: string; limit: number; signal: AbortSignal }): Promise<string[]>;
  /**
   * Remove chunks so they can no longer be retrieved.
   *
   * Optional on purpose. Retrieval benchmarks never call it, and a system with no
   * deletion primitive should say so by omitting it rather than by silently
   * accepting a forget that does nothing. `asBenchmarkCondition` reports the
   * absence instead of pretending the operation succeeded.
   */
  forget?(ids: string[], operation: { signal: AbortSignal }): Promise<void>;
  /** Release every resource, including files created outside the process. */
  close(): Promise<void>;
}

/**
 * A system that can be scored in a matched run.
 *
 * `mode` is printed verbatim in every report and table row. It is the sentence a
 * reader needs in order not to mistake one configuration for another: which
 * package at which version, which extraction path, which retrieval path, which
 * embedding model. It is a caller attestation, exactly like `BenchmarkReader.mode`
 * in the agent benchmark, and is never independently authenticated by the harness.
 */
export interface MatchedSystem {
  /** Stable, lowercase, hyphenated. Becomes the condition id `system:<id>`. */
  id: string;
  /** The adapted package's own version, not ours. */
  revision: string;
  mode: string;
  create(request: { corpusId: string; seed: number; signal: AbortSignal }): Promise<MatchedSession>;
}

/**
 * The result of trying to make a system runnable.
 *
 * A system that cannot run yields a `reason`, never a number and never a silent
 * fallback to some other configuration. Reports print the reason in the row where
 * the score would have been.
 */
export type MatchedResolution =
  | { available: true; system: MatchedSystem }
  | { available: false; reason: string };

/** A named, resolvable competitor. `resolve` reports walls; it does not throw them. */
export interface MatchedSystemFactory {
  id: string;
  /** One line naming the package and what an operator must supply to run it. */
  describe(): string;
  resolve(request: { seed: number; signal: AbortSignal }): Promise<MatchedResolution>;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Guards the identity that becomes a condition key and a report column. */
export function assertMatchedSystemId(id: string): string {
  if (typeof id !== 'string' || !ID.test(id) || id.length > 64) throw new Error('Invalid matched system id.');
  return id;
}

/** The condition key a matched system runs under, kept distinct from the built-in conditions. */
export function matchedConditionId(id: string): `system:${string}` {
  return `system:${assertMatchedSystemId(id)}`;
}

/**
 * Rejects an adapter that returns identities it was never given, duplicates, or
 * more hits than the limit allowed. A system that hallucinates an identity would
 * otherwise be silently credited with evidence it never retrieved.
 */
export function checkRetrievedIds(ids: unknown, known: ReadonlySet<string>, limit: number): string[] {
  if (!Array.isArray(ids)) throw new Error('A matched system must return an array of chunk identities.');
  if (ids.length > limit) throw new Error('A matched system returned more hits than the requested limit.');
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !known.has(id)) throw new Error('A matched system returned an unknown chunk identity.');
    if (seen.has(id)) throw new Error('A matched system returned a duplicate chunk identity.');
    seen.add(id);
  }
  return ids as string[];
}
