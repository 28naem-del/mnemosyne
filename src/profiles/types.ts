import type { z } from 'zod';
import type { JsonValue, MemorySource, MemoryTrust } from '../local/index.js';
import type { MemoryMaintenance } from '../maintenance/index.js';

export type ProfileSchema = Record<string, z.ZodType>;
declare const definitionType: unique symbol;
/** Recreate the same definition after reopening. The runtime token itself is instance-bound. */
export interface ProfileDefinition<S extends ProfileSchema = ProfileSchema> {
  readonly key: string;
  readonly version: string;
  readonly schemaFingerprint: string;
  readonly fieldNames: readonly (keyof S & string)[];
  readonly [definitionType]?: S;
}
export interface ProfileSupport<T> { value: T; sourceIds: string[] }
/** A source citation records attribution, not proof that a model's interpretation is true. */
export type ProfileField<T> =
  | ({ status: 'known' } & ProfileSupport<T>)
  | { status: 'unknown' }
  | { status: 'conflict'; candidates: ProfileSupport<T>[] };
export type ProfileFields<S extends ProfileSchema> = { [K in keyof S]: ProfileField<z.output<S[K]>> };
export interface ProfileSnapshot<S extends ProfileSchema = ProfileSchema> {
  key: string;
  version: string;
  schemaFingerprint: string;
  /** Every field is unknown unless status is ready. Stale values are never returned. */
  status: 'ready' | 'unknown' | 'stale' | 'disabled';
  fields: ProfileFields<S>;
  /** All supplied generation inputs, including those not cited by an individual field. */
  sourceIds: string[];
  recordId?: string;
  advisory: true;
}
export interface ProfileProposalRequest {
  instructions: string;
  key: string;
  version: string;
  schemaFingerprint: string;
  /** JSON schemas for the value of each field, before the known/unknown/conflict wrapper. */
  fields: Record<string, JsonValue>;
  sources: { id: string; text: string; trust: MemoryTrust; source: MemorySource }[];
  maxOutputBytes: number;
  maxValueBytes: number;
  signal: AbortSignal;
}
/** Explicit host callback; return { fields: { name: ProfileField, ... } } or its JSON. */
export type ProfileProposer = (request: ProfileProposalRequest) => Promise<unknown>;
export interface ProfileRefreshInput<S extends ProfileSchema = ProfileSchema> {
  definition: ProfileDefinition<S>;
  sourceIds: string[];
  proposer: ProfileProposer;
  /** Change when the model, prompt or interpretation policy changes. */
  proposerId: string;
  requireWatched?: boolean;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface ProfileRefreshResult<S extends ProfileSchema = ProfileSchema> {
  profile: ProfileSnapshot<S>;
  status: 'created' | 'reused';
  modelCalls: 0 | 1;
  /** Actual serializable host request bytes; zero only when reused before dispatch. */
  inputBytes: number;
}
export interface MemoryProfilesOptions {
  maintenance?: MemoryMaintenance;
  maxScanRecords?: number;
  maxDependencyRecords?: number;
}
export interface ProfileReadOptions { requireWatched?: boolean; signal?: AbortSignal }
