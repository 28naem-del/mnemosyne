import type { BenchmarkCondition, BenchmarkMemoryEvent, BenchmarkSession } from './agent-benchmark.js';
import { pack } from './benchmark-memory.js';
import type { MatchedSystem } from './matched-types.js';

/**
 * Adapts a matched-run system into the agent benchmark's `BenchmarkCondition`.
 *
 * The corpus benchmark measures what a system *finds*. The agent benchmark
 * measures what a reader *does* with what the system found, over an episode of
 * remembers, corrections and forgets. A competitor that only appears in the first
 * one would be compared on retrieval and never on the thing memory is actually
 * for, so the same adapter drives both — and the reader, the output allowance,
 * the packing budget and `pack()` itself are shared with every built-in
 * condition, so only the memory differs.
 *
 * Two boundaries are load-bearing:
 *
 * - **No label, condition name or episode metadata crosses into the system.** It
 *   receives the event's key and text, then a query and a budget. The reader
 *   never learns which condition produced its context.
 * - **A missing primitive is reported, not simulated.** Not every memory system
 *   can delete. Rather than accept a `forget` and let the record keep answering
 *   queries — which would score the system as if it had honoured a deletion it
 *   never performed — the bridge drops the record from the context it packs and
 *   records the divergence in `unsupported`, so a run can state plainly which
 *   systems could not carry out the episode as written.
 */

export interface MatchedConditionReport {
  /** Operations the system had no primitive for, and which the bridge handled itself. */
  unsupported: { operation: BenchmarkMemoryEvent['operation']; count: number }[];
}

export interface MatchedConditionOptions {
  /** Candidates pulled before packing. Matches the built-in lexical condition's 100. */
  retrieveLimit?: number;
  /** Receives the divergence report when a session closes. */
  onClose?(report: MatchedConditionReport): void;
}

/** A deterministic, collision-free chunk identity for an episode key. */
const chunkId = (key: string, revision: number): string => `${key}#${revision}`;

export function asBenchmarkCondition(system: MatchedSystem, options: MatchedConditionOptions = {}): BenchmarkCondition {
  const retrieveLimit = options.retrieveLimit ?? 100;
  if (!Number.isSafeInteger(retrieveLimit) || retrieveLimit < 1 || retrieveLimit > 1000) throw new Error('Invalid retrieve limit.');
  return {
    id: `system:${system.id}`,
    revision: system.revision,
    async create(request): Promise<BenchmarkSession> {
      const session = await system.create({ corpusId: `agent-${request.seed}`, seed: request.seed, signal: request.signal });
      // key -> the live chunk identity and its text. A correction writes a new
      // identity rather than mutating one, because a system with no update
      // primitive would otherwise keep returning the superseded text.
      const live = new Map<string, { id: string; text: string }>();
      const revisions = new Map<string, number>();
      const unsupported = new Map<BenchmarkMemoryEvent['operation'], number>();
      const note = (operation: BenchmarkMemoryEvent['operation']) => unsupported.set(operation, (unsupported.get(operation) ?? 0) + 1);

      const drop = async (key: string, operation: BenchmarkMemoryEvent['operation'], signal: AbortSignal): Promise<void> => {
        const previous = live.get(key);
        if (!previous) return;
        live.delete(key);
        if (typeof session.forget === 'function') await session.forget([previous.id], { signal });
        // Without a deletion primitive the record is still inside the system and
        // can still be returned. It is excluded from the packed context here, and
        // the gap between "the episode asked for a deletion" and "the system
        // performed one" is counted rather than hidden.
        else note(operation);
      };

      return {
        async apply(event, signal): Promise<void> {
          signal.throwIfAborted();
          if (event.operation === 'forget') { await drop(event.key, 'forget', signal); return; }
          if (event.operation === 'correct') await drop(event.key, 'correct', signal);
          const revision = (revisions.get(event.key) ?? 0) + 1;
          revisions.set(event.key, revision);
          const id = chunkId(event.key, revision);
          await session.ingest([{ id, text: event.text }], { signal });
          live.set(event.key, { id, text: event.text });
        },
        async context({ query, maxContextUnits, signal }) {
          const ranked = await session.retrieve({ query, limit: retrieveLimit, signal });
          const byId = new Map([...live].map(([key, record]) => [record.id, { key, text: record.text }]));
          const records = ranked.flatMap(id => { const found = byId.get(id); return found ? [found] : []; });
          return pack(records, maxContextUnits);
        },
        async close(): Promise<void> {
          try { await session.close(); }
          finally { options.onClose?.({ unsupported: [...unsupported].map(([operation, count]) => ({ operation, count })) }); }
        },
      };
    },
  };
}
