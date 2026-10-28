/**
 * Shapes shared by the breakthrough demo (`mnemosy demo`) and its moments.
 *
 * A moment is one claim the demo makes to a new user, the lines it showed while
 * making it, and one proof number it measured live on this machine. The proof is
 * never a constant: a moment that cannot measure its number reports `pending`,
 * and a moment whose number misses its threshold reports `passed: false`.
 */

/** Moment ids follow MASTER-PLAN §11.7: five moments, in the order a new user meets them. */
export type MomentId = 1 | 2 | 3 | 4 | 5;

export interface MomentProof {
  /** What was measured, e.g. `replay determinism`. */
  label: string;
  /** The live measurement. A string when the measurement is a ratio or a tuple (`200/200 identical`). */
  measured: number | string;
  /** The bar the measurement is held to, in words. */
  threshold: string;
  /** `pending` only for a moment whose implementation has not landed yet. */
  passed: boolean | 'pending';
}

export interface Moment {
  id: MomentId;
  title: string;
  /** Everything the user saw for this moment, in order, PROOF line included. */
  lines: string[];
  proof: MomentProof;
  durationMs: number;
  /** Structured numbers behind the proof, for `--record` and the tests. Never printed as the proof itself. */
  details?: Record<string, unknown>;
}

/** What a moment is handed. `say` streams one line to the user and records it on the moment. */
export interface MomentContext {
  say: (line: string) => void;
  seed: number;
  /** Store size for the bisect moment. */
  records: number;
  /** Cut points for the replay-determinism moment. */
  cutPoints: number;
}

/** What a moment's run function returns; the framework adds `id`, `title`, `lines` and `durationMs`. */
export interface MomentOutcome {
  proof: MomentProof;
  details?: Record<string, unknown>;
}

export interface MomentDefinition {
  id: MomentId;
  title: string;
  /**
   * Runs the moment. Absent while the moment is pending; `pendingNote` then says
   * which unit delivers it. Implementing a pending moment is adding this one
   * function — see `BREAKTHROUGH_MOMENTS` in `../breakthrough-demo.ts`.
   */
  run?: (context: MomentContext) => MomentOutcome | Promise<MomentOutcome>;
  pendingNote?: string;
  /** The proof label and threshold the moment will be held to, shown even while pending. */
  proofLabel: string;
  threshold: string;
}

export interface BreakthroughDemoOptions {
  /** Receives every line as the demo produces it. Defaults to discarding them. */
  out?: (line: string) => void;
  /** Seed for every synthetic corpus and every random cut point. Defaults to 20261028. */
  seed?: number;
  /** Records in the bisect store, 2000 to 50000. Defaults to 2000, the §11.7 floor. */
  records?: number;
  /** Random `(asOf, knownAt)` cut points the replay moment hashes twice, 1 to 10000. Defaults to 1000. */
  cutPoints?: number;
}

export interface BreakthroughDemoReport {
  generatedAt: string;
  durationMs: number;
  moments: Moment[];
  /** Implemented moments whose proof passed. */
  passed: number;
  /** Implemented moments; pending ones are listed in `pending` and counted in neither. */
  total: number;
  /** Titles of moments registered but not yet implemented, with the unit that delivers each. */
  pending: string[];
  limitations: string[];
}
