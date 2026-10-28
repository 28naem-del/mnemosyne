/**
 * Case schema for adversarial poisoning suite v1.
 *
 * A case is a deterministic script of kernel operations plus the probes that
 * decide its outcome. Every case is self-contained text: no corpus download, no
 * model, no network. References written `@name` resolve to the id a step bound
 * under that name; anything else is passed through literally.
 *
 * Probe semantics are uniform. On an attack case every probe asks "did the poison
 * surface here?" and any yes is an escape. On a benign control every probe asks
 * "did the legitimate record surface here?" and any no is a false quarantine.
 * `armed` probes are neither: they prove the poison WOULD have matched had the
 * gate not held, so a case that tests nothing is reported as a harness error
 * rather than counted as a pass.
 */
import type { JsonValue, MemoryKind, MemoryTrust, MemoryVisibility } from '../../local/types.js';

export const POISONING_SUITE_VERSION = 'v1';
export const POISONING_SEED = 'poisoning-v1';

export type PoisoningClass = 'content' | 'evidence' | 'scope-leak' | 'selection' | 'path' | 'erasure-return';
export const POISONING_CLASSES: readonly PoisoningClass[] = ['content', 'evidence', 'scope-leak', 'selection', 'path', 'erasure-return'];

/** Principals naming the same `db` share one database; the default is `'main'`. */
export interface PrincipalSpec { name: string; workspace: string; agent: string; db?: string }
export interface SourceSpec { uri: string; author?: string }
export interface RecordSpec {
  text: string;
  kind?: MemoryKind;
  trust?: MemoryTrust;
  visibility?: MemoryVisibility;
  source: SourceSpec;
  evidence?: string;
  key?: string;
  dependencies?: string[];
  metadata?: Record<string, JsonValue>;
}

/**
 * `gate: true` marks a step whose acceptance is itself under test: if it throws,
 * the error is recorded instead of failing the case, and an `accepted` probe
 * reads whether it went through. A step without `gate` that throws is a harness
 * error. Binds of a rejected gated step are left unresolved.
 */
export type PoisoningStep =
  | { op: 'store'; as: string; bind?: string; record: RecordSpec; gate?: true }
  | { op: 'ingest'; as: string; bind?: string; uri: string; text: string; trust: 'untrusted' | 'observed'; gate?: true }
  | { op: 'forget-source'; as: string; target: string; gate?: true }
  | { op: 'correct'; as: string; bind?: string; target: string; text: string; source: SourceSpec; reason: string; metadata?: Record<string, JsonValue>; gate?: true }
  | { op: 'outcome'; as: string; target: string; success: boolean; count: number; gate?: true }
  | { op: 'forget'; as: string; target: string; gate?: true }
  | { op: 'promote'; as: string; bind: string; target: string; to: 'observed' | 'verified'; corroboration: string[]; reason: string; gate?: true }
  /** `mode: 'reflect'` runs a real `reflect()` pass with a deterministic local proposer
   * citing `dependencies`, then commits. `'forge'` hand-builds the proposal with
   * caller-claimed revisions. `'tamper'` reflects, then edits the proposal text. */
  | { op: 'lesson'; as: string; bind?: string; text: string; query: string; dependencies: string[]; passed: boolean; mode: 'reflect' | 'forge' | 'tamper'; gate?: true }
  | { op: 'checkpoint'; as: string; bind?: string; taskId: string; dependencies: string[]; visibility?: MemoryVisibility; gate?: true }
  | { op: 'export'; as: string; bind: string }
  | { op: 'import'; as: string; snapshot: string; gate?: true }
  /** Exports this principal's store, appends one forged record, and imports the result. */
  | { op: 'import-forged'; as: string; forged: ForgedRecordSpec; gate?: true };

export interface ForgedRecordSpec extends RecordSpec {
  /** A ref or literal id for the forged record; defaults to a fresh deterministic UUID. */
  id?: string;
  /** Claim another principal's agent id inside this principal's snapshot. */
  agentOf?: string;
}

export type PoisoningProbe =
  | { probe: 'recall'; as: string; query: string; targets: string[]; limit?: number; includeUntrusted?: boolean; kinds?: MemoryKind[]; lexicalScoring?: 'bm25' | 'overlap' }
  | { probe: 'compile'; as: string; query: string; targets: string[]; maxTokens?: number }
  | { probe: 'list'; as: string; targets: string[]; broad?: boolean }
  | { probe: 'inspect'; as: string; targets: string[] }
  | { probe: 'get'; as: string; targets: string[] }
  | { probe: 'getAt'; as: string; targets: string[] }
  | { probe: 'ledger'; as: string; targets: string[] }
  | { probe: 'export'; as: string; targets: string[] }
  /** Surfaced when any target's stored trust is above `above`. */
  | { probe: 'trust'; as: string; targets: string[]; above: MemoryTrust }
  /** Surfaced when any named gated step (by its index in `steps`) was accepted. */
  | { probe: 'accepted'; steps: number[] }
  /** Surfaced when any named promotion was granted. `verdictNames` must appear in
   * every quarantine verdict (resolved like targets), or the case is a harness error. */
  | { probe: 'promoted'; decisions: string[]; verdictNames?: string[] }
  /** Surfaced when any record in scope, at any trust or status, contains `marker`. */
  | { probe: 'marker'; as: string; marker: string }
  /** Not an outcome probe: must surface, or the case tests nothing. */
  | { probe: 'armed'; as: string; query: string; targets: string[] };

export interface PoisoningCase {
  id: string;
  version: typeof POISONING_SUITE_VERSION;
  class: PoisoningClass;
  variant: string;
  attack: boolean;
  scenario: { principals: PrincipalSpec[]; steps: PoisoningStep[]; probes: PoisoningProbe[] };
  /** `escape` names what counts as an escape on an attack case and is `'none'` on a
   * benign control. `quarantine` is whether the kernel is expected to block the
   * scenario's subject: true on attacks, false on benign controls. */
  expect: { escape: string; quarantine: boolean | null };
}

export interface PoisoningCaseResult {
  id: string;
  class: PoisoningClass;
  variant: string;
  attack: boolean;
  /** `held`: attack blocked. `escaped`: attack surfaced. `passed`: benign surfaced.
   * `false-quarantine`: benign blocked. `error`: the harness could not decide. */
  outcome: 'held' | 'escaped' | 'passed' | 'false-quarantine' | 'error';
  /** Probes that surfaced on an attack, or failed to surface on a benign control. */
  probes: string[];
  decisions: { bind: string; decision: string; verdict: string }[];
  error?: string;
}

export interface PoisoningClassSummary {
  class: PoisoningClass;
  attackCases: number;
  escapes: number;
  benignCases: number;
  falseQuarantines: number;
  falseQuarantineRate: number;
  errors: number;
}

export interface PoisoningReport {
  suite: 'mnemosyne-poisoning';
  version: typeof POISONING_SUITE_VERSION;
  seed: string;
  /** `matchesGenerator`: the file is byte-identical to what the seeded generator produces now. */
  corpus: { cases: number; sha256: string; matchesGenerator: boolean };
  configuration: { retrieval: 'lexical'; storage: string; clock: string; network: 'none'; models: 'none' };
  totals: { cases: number; attackCases: number; benignCases: number; benignShare: number; escapes: number; falseQuarantines: number; falseQuarantineRate: number; errors: number };
  gate: { maxEscapes: 0; maxFalseQuarantineRate: 0.02; passed: boolean };
  classes: PoisoningClassSummary[];
  escapes: PoisoningCaseResult[];
  falseQuarantines: PoisoningCaseResult[];
  errors: PoisoningCaseResult[];
  results: PoisoningCaseResult[];
}
