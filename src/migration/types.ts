/** Explicit, offline source profiles. These are not account archive parsers. */
export const MIGRATION_PROFILES = Object.freeze([
  'mnemosyne-memcell-array', 'mnemosyne-qdrant-scroll', 'markdown', 'mem0-array', 'mem0-results', 'mem0-page', 'letta-blocks',
  'langgraph-store-items', 'graphiti-edges', 'hindsight-memories', 'supermemory-documents',
] as const);
export type MigrationProfile = typeof MIGRATION_PROFILES[number];
export type MigrationFamily = 'mnemosyne' | 'markdown' | 'mem0' | 'letta' | 'langgraph' | 'graphiti' | 'hindsight' | 'supermemory';
export type MigrationDisposition = 'create' | 'unchanged' | 'quarantine' | 'excluded' | 'conflict' | 'invalid';
export type MigrationFieldStatus = 'preserved-active' | 'preserved-raw-only' | 'downgraded' | 'not-retained' | 'unsupported';
export interface MigrationArtifact {
  /** Diagnostic logical name only; never opened as a path. */
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly profile: MigrationProfile;
  /** Required for Markdown; becomes source identity, never a destination path. */
  readonly logicalPath?: string;
  /** Caller attests this artifact's zero-based position in a complete page set. */
  readonly page?: { readonly index: number; readonly totalPages: number };
}
export interface MigrationLimits {
  readonly maxInputBytes?: number;
  readonly maxRecords?: number;
  readonly maxSourceBytes?: number;
  readonly maxArtifacts?: number;
}
export interface MigrationPlanOptions {
  readonly sourceStore: string;
  /** Required for both legacy Mnemosyne profiles. */
  readonly collection?: string;
  readonly sourceOwner: {
    /** Defaults: Mnemosyne agent, Mem0 user, Letta creator. Other profiles require assumeMissing; namespaces, banks and tags do not authenticate ownership. */
    readonly field?: 'agent' | 'user' | 'creator';
    readonly allowedIds: readonly string[];
    /** Explicit export-scope assertion for records lacking the selected field. */
    readonly assumeMissing?: string;
  };
  readonly destination: { readonly workspaceId: string; readonly agentId: string };
  readonly trust?: 'untrusted' | 'observed';
  /** Explicit UTC instant makes lifecycle interpretation reproducible. */
  readonly evaluatedAt: string;
  /** Acknowledges unknown/partial exports and intentionally excluded owners. */
  readonly acknowledgePartial?: boolean;
  /** Qdrant arbitrary payloads require an explicit top-level text field. */
  readonly qdrantTextField?: string;
  readonly limits?: MigrationLimits;
}
export interface NormalizedMigrationOptions {
  readonly sourceStore: string;
  readonly collection?: string;
  readonly sourceOwner: { readonly field?: 'agent' | 'user' | 'creator'; readonly allowedIds: readonly string[]; readonly assumeMissing?: string };
  readonly destination: { readonly workspaceId: string; readonly agentId: string; readonly visibility: 'private' };
  readonly trust: 'untrusted' | 'observed';
  readonly evaluatedAt: string;
  readonly acknowledgePartial: boolean;
  readonly qdrantTextField?: string;
  readonly limits: Readonly<Required<MigrationLimits>>;
}
export interface MigrationIssue {
  /** Stable code and sanitized explanation; never contains rejected source text. */
  readonly code: string;
  readonly message: string;
  readonly severity: 'warning' | 'error';
  readonly byteOffset?: number;
}
export interface MigrationFieldMapping {
  readonly pointer: string;
  readonly status: MigrationFieldStatus;
  readonly reason: string;
}
export interface MigrationPlannedRecord {
  readonly artifactIndex: number;
  readonly pointer: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly rawBytes: number;
  readonly rawHash: string;
  readonly family: MigrationFamily;
  readonly profile: MigrationProfile;
  readonly externalId?: string;
  readonly sourceOwner?: string;
  readonly ownerAssumed: boolean;
  /** Hash of family/store/collection/selected owner/external ID; no export filename. */
  readonly identity?: string;
  /** Sorted JSON with exact normalized numeric tokens, or exact Markdown bytes. */
  readonly canonicalHash?: string;
  readonly disposition: MigrationDisposition;
  readonly trust: 'untrusted' | 'observed';
  readonly visibility: 'private';
  /** Present only for the single retained representative of a create/quarantine. */
  readonly rawText?: string;
  /** Ordinary observation only; never a prompt, procedure or runtime setting. */
  readonly text?: string;
  readonly originalTextBytes: number;
  readonly mappedTextBytes: number;
  readonly mappings: readonly MigrationFieldMapping[];
  readonly issues: readonly MigrationIssue[];
}
export interface MigrationInputReport {
  readonly artifactIndex: number;
  readonly name: string;
  readonly profile: MigrationProfile;
  readonly logicalPath?: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly recordCount: number;
  readonly framingBytes: number;
  readonly rejectedInputBytes: number;
  /** On parse failure only: diagnostic remainder, a subset of rejectedInputBytes. */
  readonly unparsedBytes?: number;
  readonly issues: readonly MigrationIssue[];
  readonly page?: { readonly index: number; readonly totalPages: number };
  readonly reportedTotal?: number;
  readonly hasNext?: boolean;
  readonly hasPrevious?: boolean;
  /** Upstream offset evidence, independent of caller page declarations. */
  readonly offset?: number;
  readonly pageLimit?: number;
}
export interface MigrationPlanReport {
  readonly destinationInspected: false;
  readonly readyToApply: boolean;
  readonly recordsSeen: number;
  readonly counts: Readonly<Record<MigrationDisposition, number>>;
  readonly completeness: { readonly status: 'complete' | 'partial' | 'unknown'; readonly reasons: readonly string[]; readonly suppliedUniqueIds: number; readonly upstreamTotals: readonly number[] };
  readonly accounting: {
    readonly suppliedBytes: number;
    readonly retainedRawBytes: number;
    readonly excludedRawBytes: number;
    readonly invalidRawBytes: number;
    readonly conflictRawBytes: number;
    readonly duplicateRawBytesNotRetained: number;
    readonly framingBytesNotRetained: number;
    readonly rejectedInputBytes: number;
    readonly originalTextBytes: number;
    readonly mappedTextBytes: number;
  };
  readonly proposedSources: number;
  readonly proposedObservations: number;
  /** Blank source units, a subset of proposedEncodedSourceControls. */
  readonly proposedEmptySourceControls: number;
  /** Blank or literal-NUL source units requiring exact raw encoding controls. */
  readonly proposedEncodedSourceControls: number;
  /** Raw plus projected text bytes, excluding destination indexes/journals/metadata. */
  readonly proposedTextStorageBytes: number;
  readonly fieldCounts: Readonly<Record<MigrationFieldStatus, number>>;
  readonly issues: readonly MigrationIssue[];
}
export interface MigrationPlan {
  readonly version: 1;
  readonly parserVersion: 'mnemosyne-migration-v1';
  readonly options: NormalizedMigrationOptions;
  readonly inputs: readonly MigrationInputReport[];
  readonly records: readonly MigrationPlannedRecord[];
  readonly report: MigrationPlanReport;
  /** Artifact-order-sensitive authorization digest; source identities remain order-independent. */
  readonly planHash: string;
}
export class MigrationPlanError extends Error {
  readonly code: 'E_OPTIONS' | 'E_INPUT' | 'E_LIMIT';
  constructor(code: 'E_OPTIONS' | 'E_INPUT' | 'E_LIMIT', message: string) { super(message); this.name = 'MigrationPlanError'; this.code = code; }
}
