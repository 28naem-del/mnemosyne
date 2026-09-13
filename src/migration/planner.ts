import { createHash } from 'node:crypto';
import { migrationOriginIdentity } from './origins.js';
import { MEMORY_TYPES } from '../core/types.js';
import { parseJsonWithSpans, JsonSpanError, type JsonSpanNode } from './json-spans.js';
import { MIGRATION_PROFILES, MigrationPlanError, type MigrationArtifact, type MigrationFamily, type MigrationFieldMapping, type MigrationFieldStatus, type MigrationInputReport, type MigrationIssue, type MigrationPlan, type MigrationPlannedRecord, type MigrationPlanOptions, type MigrationProfile, type NormalizedMigrationOptions } from './types.js';

const DEFAULT_LIMITS = Object.freeze({ maxInputBytes: 4 * 1024 * 1024, maxRecords: 1000, maxSourceBytes: 65536, maxArtifacts: 256 });
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const byteLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!;
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const bytesOf = (value: string): number => Buffer.byteLength(value, 'utf8');
const issue = (code: string, message: string, severity: 'warning' | 'error' = 'error'): MigrationIssue => ({ code, message, severity });
const familyOf = (profile: MigrationProfile): MigrationFamily => profile.split('-')[0] as MigrationFamily;
const pointerPart = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
type ObjectNode = Extract<JsonSpanNode, { kind: 'object' }>;
type MutableRecord = { -readonly [K in keyof MigrationPlannedRecord]: MigrationPlannedRecord[K] };
interface OwnedArtifact { name: string; profile: MigrationProfile; bytes: Uint8Array; logicalPath?: string; page?: { index: number; totalPages: number } }

function reject(code: 'E_OPTIONS' | 'E_INPUT' | 'E_LIMIT', message: string): never { throw new MigrationPlanError(code, message); }
function plain(value: unknown, allowed: readonly string[], code: 'E_OPTIONS' | 'E_INPUT'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject(code, 'Expected a plain data object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.entries(descriptors).some(([key, descriptor]) => !allowed.includes(key) || !('value' in descriptor))) reject(code, 'Unexpected field or accessor.');
  return value as Record<string, unknown>;
}
function array(value: unknown, cap: number, code: 'E_OPTIONS' | 'E_INPUT'): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > cap || Object.getOwnPropertySymbols(value).length) reject(code, 'Expected a bounded ordinary data array.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || !('value' in descriptors[key]))) || Object.keys(descriptors).length !== value.length + 1) reject(code, 'Sparse arrays and accessors are unsupported.');
  // Never invoke a caller's map/some/iterator, including inherited overrides.
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index++) copy.push(descriptors[String(index)].value);
  return copy;
}
function label(value: unknown, code: 'E_OPTIONS' | 'E_INPUT', cap = 512): string {
  if (typeof value !== 'string' || !value.trim() || bytesOf(value) > cap || /[\u0000-\u001f\u007f]/u.test(value) || /[\uD800-\uDFFF]/u.test(value)) reject(code, 'Expected a nonempty bounded identifier without control characters.');
  return value;
}
function instant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  const normalized = new Date(time).toISOString();
  return normalized === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z') ? normalized : undefined;
}
/** Explicit RFC3339 source timestamps, compared without rounding microseconds. */
function foreignInstant(value: unknown): bigint | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;
  const base = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 19) !== match[1]) return undefined;
  const hours = Number(match[5] ?? 0), minutes = Number(match[6] ?? 0);
  // RFC3339 -00:00 means an unknown local offset, not an assertion of UTC.
  if (hours > 23 || minutes > 59 || match[3] === '-00:00') return undefined;
  const offset = (hours * 60 + minutes) * (match[4] === '-' ? -1 : 1);
  return BigInt(base - offset * 60000) * 1000000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
function normalizeOptions(input: MigrationPlanOptions): NormalizedMigrationOptions {
  const data = plain(input, ['sourceStore', 'collection', 'sourceOwner', 'destination', 'trust', 'evaluatedAt', 'acknowledgePartial', 'qdrantTextField', 'limits'], 'E_OPTIONS');
  const owner = plain(data.sourceOwner, ['field', 'allowedIds', 'assumeMissing'], 'E_OPTIONS');
  const destination = plain(data.destination, ['workspaceId', 'agentId'], 'E_OPTIONS');
  const allowedIds = [...new Set(array(owner.allowedIds, 1000, 'E_OPTIONS').map(id => label(id, 'E_OPTIONS'))) ].sort();
  if (!allowedIds.length || owner.field !== undefined && !['agent', 'user', 'creator'].includes(owner.field as string)) reject('E_OPTIONS', 'Select at least one source owner and a supported owner field.');
  const assumeMissing = owner.assumeMissing === undefined ? undefined : label(owner.assumeMissing, 'E_OPTIONS');
  if (assumeMissing !== undefined && !allowedIds.includes(assumeMissing)) reject('E_OPTIONS', 'The assumed source owner must be selected.');
  if (data.trust !== undefined && !['untrusted', 'observed'].includes(data.trust as string)) reject('E_OPTIONS', 'Imported trust must be untrusted or observed.');
  const evaluatedAt = instant(data.evaluatedAt);
  if (!evaluatedAt) reject('E_OPTIONS', 'evaluatedAt must be an explicit valid UTC instant.');
  if (data.acknowledgePartial !== undefined && typeof data.acknowledgePartial !== 'boolean') reject('E_OPTIONS', 'acknowledgePartial must be boolean.');
  const limits: Record<keyof typeof DEFAULT_LIMITS, number> = { ...DEFAULT_LIMITS };
  if (data.limits !== undefined) {
    const supplied = plain(data.limits, Object.keys(DEFAULT_LIMITS), 'E_OPTIONS');
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]) if (supplied[key] !== undefined) {
      const value = supplied[key];
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > DEFAULT_LIMITS[key]) reject('E_LIMIT', 'Migration limits may only reduce the documented maximums.');
      limits[key] = value as number;
    }
  }
  return {
    sourceStore: label(data.sourceStore, 'E_OPTIONS'),
    ...(data.collection === undefined ? {} : { collection: label(data.collection, 'E_OPTIONS') }),
    sourceOwner: { ...(owner.field === undefined ? {} : { field: owner.field as 'agent' | 'user' | 'creator' }), allowedIds, ...(assumeMissing === undefined ? {} : { assumeMissing }) },
    destination: { workspaceId: label(destination.workspaceId, 'E_OPTIONS'), agentId: label(destination.agentId, 'E_OPTIONS'), visibility: 'private' },
    trust: data.trust as 'untrusted' | 'observed' | undefined ?? 'untrusted', evaluatedAt,
    acknowledgePartial: data.acknowledgePartial as boolean | undefined ?? false,
    ...(data.qdrantTextField === undefined ? {} : { qdrantTextField: label(data.qdrantTextField, 'E_OPTIONS', 256) }), limits,
  };
}
function ownArtifacts(input: readonly MigrationArtifact[], options: NormalizedMigrationOptions): OwnedArtifact[] {
  const values = array(input, options.limits.maxArtifacts, 'E_INPUT');
  if (!values.length) reject('E_INPUT', 'Supply at least one explicit artifact.');
  let total = 0;
  const names = new Set<string>();
  return values.map(value => {
    const data = plain(value, ['name', 'bytes', 'profile', 'logicalPath', 'page'], 'E_INPUT');
    const name = label(data.name, 'E_INPUT');
    if (names.has(name)) reject('E_INPUT', 'Artifact diagnostic names must be unique.'); names.add(name);
    if (!MIGRATION_PROFILES.includes(data.profile as MigrationProfile)) reject('E_INPUT', 'Select an explicitly supported source profile.');
    const profile = data.profile as MigrationProfile;
    if (!(data.bytes instanceof Uint8Array)) reject('E_INPUT', 'Artifact bytes must be a Uint8Array.');
    const length = byteLengthGetter.call(data.bytes) as number;
    if (typeof SharedArrayBuffer !== 'undefined' && bufferGetter.call(data.bytes) instanceof SharedArrayBuffer) reject('E_INPUT', 'Shared mutable input buffers are unsupported.');
    total += length; if (total > options.limits.maxInputBytes) reject('E_LIMIT', 'Supplied input bytes exceed the migration limit.');
    const bytes = new Uint8Array(length); Uint8Array.prototype.set.call(bytes, data.bytes);
    let logicalPath: string | undefined;
    if (profile === 'markdown') {
      logicalPath = label(data.logicalPath, 'E_INPUT', 1024);
      if (logicalPath.includes('\\') || logicalPath.split('/').some(segment => !segment || segment === '.' || segment === '..')) reject('E_INPUT', 'Markdown requires a canonical relative logical path.');
    } else if (data.logicalPath !== undefined) reject('E_INPUT', 'logicalPath is only valid for Markdown.');
    let page: { index: number; totalPages: number } | undefined;
    if (data.page !== undefined) {
      const pageData = plain(data.page, ['index', 'totalPages'], 'E_INPUT');
      if (!Number.isSafeInteger(pageData.index) || !Number.isSafeInteger(pageData.totalPages) || (pageData.index as number) < 0 || (pageData.totalPages as number) < 1 || (pageData.totalPages as number) > 1000000 || (pageData.index as number) >= (pageData.totalPages as number)) reject('E_INPUT', 'Invalid bounded page declaration.');
      page = { index: pageData.index as number, totalPages: pageData.totalPages as number };
    }
    return { name, profile, bytes, ...(logicalPath === undefined ? {} : { logicalPath }), ...(page === undefined ? {} : { page }) };
  });
}
const member = (node: JsonSpanNode | undefined, key: string): JsonSpanNode | undefined => node?.kind === 'object' ? node.members.find(entry => entry.key === key)?.value : undefined;
function requireObject(node: JsonSpanNode | undefined): ObjectNode {
  if (node?.kind !== 'object') throw issue('E_PROFILE', 'The selected profile requires an object at this position.');
  return node;
}
function requireArray(node: JsonSpanNode | undefined): readonly JsonSpanNode[] {
  if (node?.kind !== 'array') throw issue('E_PROFILE', 'The selected profile requires a record array at this position.');
  return node.elements;
}
function canonicalNumber(token: string): string {
  // Compare exact decimal values without rounding unknown metadata or identifiers.
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
  let coefficient = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
  if (!coefficient) return '0';
  const withoutZeros = coefficient.replace(/0+$/, '');
  const exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length) + BigInt(coefficient.length - withoutZeros.length);
  coefficient = withoutZeros;
  return `${match[1]}${coefficient}e${exponent}`;
}
function canonical(node: JsonSpanNode, bytes: Uint8Array): string {
  if (node.kind === 'object') return `{${[...node.members].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(entry => `${JSON.stringify(entry.key)}:${canonical(entry.value, bytes)}`).join(',')}}`;
  if (node.kind === 'array') return `[${node.elements.map(value => canonical(value, bytes)).join(',')}]`;
  if (node.kind !== 'number') return JSON.stringify(node.value);
  return canonicalNumber(decoder.decode(bytes.subarray(node.startByte, node.endByte)));
}
function exactCount(node: JsonSpanNode | undefined, artifact: OwnedArtifact, minimum = 0): number {
  if (node?.kind !== 'number' || !Number.isSafeInteger(node.value) || node.value < minimum || canonical(node, artifact.bytes) !== canonicalNumber(String(node.value))) throw issue('E_PROFILE', 'Pagination requires exact bounded integer counts, limits and offsets.');
  return node.value;
}
function selectRecords(artifact: OwnedArtifact, root: JsonSpanNode): { nodes: readonly JsonSpanNode[]; prefix: string; reportedTotal?: number; hasNext?: boolean; hasPrevious?: boolean; offset?: number; pageLimit?: number } {
  const profile = artifact.profile;
  if (['mnemosyne-memcell-array', 'mem0-array', 'letta-blocks', 'langgraph-store-items', 'graphiti-edges'].includes(profile)) return { nodes: requireArray(root), prefix: '' };
  const object = requireObject(root);
  if (profile === 'hindsight-memories' || profile === 'supermemory-documents') {
    // Read only the documented list envelope. Neither a recall result nor a summary
    // response is a substitute for the original selected records.
    const hindsight = profile === 'hindsight-memories';
    if (['next', 'previous', 'nextCursor', 'next_cursor', 'hasMore', 'has_more'].some(key => member(object, key))) throw issue('E_PROFILE', 'This profile supports offset/page pagination only; cursor or continuation wrappers require an explicit adapter and are never followed.');
    const nodes = requireArray(member(object, hindsight ? 'items' : 'memories'));
    const pagination = hindsight ? object : requireObject(member(object, 'pagination'));
    const total = exactCount(member(pagination, hindsight ? 'total' : 'totalItems'), artifact);
    const limit = exactCount(member(pagination, 'limit'), artifact, 1);
    let offset: number;
    if (hindsight) {
      offset = exactCount(member(pagination, 'offset'), artifact);
      if (artifact.page && (offset !== artifact.page.index * limit || artifact.page.totalPages !== Math.max(1, Math.ceil(total / limit)))) throw issue('E_PROFILE', 'Hindsight offset/limit/total contradict the declared pages; provide the matching complete page set or omit page assertions and acknowledge a partial selection.');
    } else {
      if (member(object, 'documents')) throw issue('E_PROFILE', 'This profile supports the documented memories envelope only; do not combine alternate document lists.');
      const currentPage = exactCount(member(pagination, 'currentPage'), artifact, 1);
      const totalPages = exactCount(member(pagination, 'totalPages'), artifact);
      if (totalPages !== Math.ceil(total / limit) || currentPage > Math.max(1, totalPages)) throw issue('E_PROFILE', 'Supermemory pagination is inconsistent with its total and limit.');
      if (artifact.page && (artifact.page.index !== currentPage - 1 || artifact.page.totalPages !== Math.max(1, totalPages))) throw issue('E_PROFILE', 'Supermemory page metadata contradicts the caller page declaration.');
      offset = (currentPage - 1) * limit;
    }
    if (!Number.isSafeInteger(offset) || offset > total || nodes.length > limit || offset + nodes.length > total) throw issue('E_PROFILE', 'The list size, offset and total are inconsistent; supply an unmodified supported list response.');
    return { nodes, prefix: hindsight ? '/items' : '/memories', reportedTotal: total, hasNext: offset + nodes.length < total, hasPrevious: offset > 0, offset, pageLimit: limit };
  }
  if (profile === 'mnemosyne-qdrant-scroll') {
    const result = requireObject(member(object, 'result'));
    const next = member(result, 'next_page_offset');
    if (!next || !['null', 'string', 'number'].includes(next.kind)) throw issue('E_PROFILE', 'Qdrant scroll requires a valid next_page_offset marker.');
    if (next.kind === 'number' && (!Number.isSafeInteger(next.value) || next.value < 0 || canonical(next, artifact.bytes) !== canonicalNumber(String(next.value)))) throw issue('E_PROFILE', 'Qdrant numeric offsets must be exact nonnegative safe integers.');
    const status = member(object, 'status');
    if (status && (status.kind !== 'string' || status.value !== 'ok')) throw issue('E_PROFILE', 'Qdrant response did not report successful status.');
    return { nodes: requireArray(member(result, 'points')), prefix: '/result/points', hasNext: next.kind !== 'null' };
  }
  const results = requireArray(member(object, 'results'));
  if (profile === 'mem0-results') {
    if (member(object, 'count') || member(object, 'next') || member(object, 'previous')) throw issue('E_PROFILE', 'A paginated Mem0 envelope requires the mem0-page profile.');
    return { nodes: results, prefix: '/results' };
  }
  const count = member(object, 'count'), next = member(object, 'next'), previous = member(object, 'previous');
  if (count?.kind !== 'number' || !Number.isSafeInteger(count.value) || count.value < 0 || canonical(count, artifact.bytes) !== canonicalNumber(String(count.value)) || !next || !['null', 'string'].includes(next.kind) || !previous || !['null', 'string'].includes(previous.kind)) throw issue('E_PROFILE', 'Mem0 pages require an exact integral count, next, previous and results.');
  return { nodes: results, prefix: '/results', reportedTotal: count.value, hasNext: next.kind !== 'null', hasPrevious: previous.kind !== 'null' };
}

const DOWNGRADED = new Set(['confidence', 'confidenceTag', 'confidence_tag', 'memoryType', 'memory_type', 'trust', 'scope', 'classification', 'verified', 'read_only', 'label', 'kind', 'visibility']);
const RAW_REASONS: Record<string, string> = {
  metadata: 'Imported metadata remains source data; no reserved runtime fields are spread into local metadata.',
  vector: 'Vectors are retained as source bytes and are not reused as embeddings.',
  linkedMemories: 'Graph associations do not establish provenance dependencies.', linked_memories: 'Graph associations do not establish provenance dependencies.',
  createdAt: 'Claimed source timestamp does not backdate ingestion or establish validity.', created_at: 'Claimed source timestamp does not backdate ingestion or establish validity.',
  updatedAt: 'Claimed source timestamp does not establish validity.', updated_at: 'Claimed source timestamp does not establish validity.',
  eventTime: 'Claimed event timestamp remains reference data.', event_time: 'Claimed event timestamp remains reference data.',
  expiration_date: 'Lifecycle metadata is interpreted conservatively; no validity date is inferred.',
  namespace: 'Namespace participates in source identity; it grants no destination ownership or sharing.',
  group_id: 'Graph group participates in source identity; it grants no destination ownership or sharing.',
  fact_embedding: 'Vectors remain exact source bytes; no foreign embedding is installed.',
  episodes: 'Foreign episode IDs are retained without inventing local evidence dependencies.',
  source_memory_ids: 'Foreign fact IDs are retained without inventing local evidence dependencies.',
  source_node_uuid: 'Graph endpoints remain raw data; no entity or relation is silently created.',
  target_node_uuid: 'Graph endpoints remain raw data; no entity or relation is silently created.',
  valid_at: 'Foreign validity is checked conservatively at preview; no local temporal interval is installed.',
  invalid_at: 'Foreign validity is checked conservatively at preview; no local temporal interval is installed.',
  expired_at: 'Foreign invalidation is checked conservatively at preview; historical records remain raw-only.',
  memories: 'Nested foreign memory histories remain raw data, not independent local memories or profiles.',
  containerTags: 'Container tags remain raw data; they do not establish source ownership or destination sharing.',
  proof_count: 'A foreign evidence count does not constitute local verification.',
  score: 'A source search score is not a local relevance score or confidence.',
};
function mappingsFor(node: JsonSpanNode | undefined, profile: MigrationProfile, textKey: string): MigrationFieldMapping[] {
  if (!node) return [{ pointer: '', status: 'preserved-active', reason: 'Literal UTF-8 Markdown becomes an ordinary observation; no frontmatter or code executes.' }];
  if (node.kind !== 'object') return [];
  const result: MigrationFieldMapping[] = [];
  const add = (field: string, prefix: string): void => {
    const pointer = `${prefix}/${pointerPart(field)}`;
    if (field === textKey && (profile !== 'mnemosyne-qdrant-scroll' || prefix === '/payload')) result.push({ pointer, status: 'preserved-active', reason: 'Copied as an ordinary observation with private visibility and caller-selected untrusted/observed provenance.' });
    else if (DOWNGRADED.has(field)) result.push({ pointer, status: 'downgraded', reason: 'Source labels confer no local trust, authority, permission, procedure or system-prompt status.' });
    else result.push({ pointer, status: 'preserved-raw-only', reason: Object.hasOwn(RAW_REASONS, field) ? RAW_REASONS[field] : 'Preserved only in the exact raw record; no active destination meaning is inferred.' });
  };
  for (const entry of node.members) {
    if (profile === 'mnemosyne-qdrant-scroll' && entry.key === 'payload' && entry.value.kind === 'object') for (const payload of entry.value.members) add(payload.key, '/payload');
    else add(entry.key, '');
  }
  return result;
}
function lifecycle(body: ObjectNode | undefined, family: MigrationFamily, options: NormalizedMigrationOptions): MigrationIssue[] {
  if (!body) return [];
  const reasons: MigrationIssue[] = [];
  const deleted = member(body, 'deleted');
  if (deleted && deleted.value !== false && deleted.kind !== 'null') reasons.push(issue('Q_DELETED', 'Deleted or ambiguous deletion state is retained as raw-only source data.', 'warning'));
  const classification = member(body, 'classification');
  if (classification?.value === 'secret') reasons.push(issue('Q_SECRET', 'A source marked secret remains private raw-only data.', 'warning'));
  if (family === 'mem0') {
    const replaced = member(body, 'replaced_by');
    if (replaced && replaced.kind !== 'null' && replaced.value !== '') reasons.push(issue('Q_REPLACED', 'A replaced source is retained as raw-only data.', 'warning'));
    const state = member(body, 'lifecycle_state');
    if (state && state.kind !== 'null' && state.value !== 'active') reasons.push(issue('Q_LIFECYCLE', 'A non-active or unknown lifecycle state is retained as raw-only data.', 'warning'));
    const expiration = member(body, 'expiration_date');
    if (expiration && expiration.kind !== 'null') {
      const parsed = instant(expiration.value);
      if (!parsed || parsed <= options.evaluatedAt) reasons.push(issue(parsed ? 'Q_EXPIRED' : 'Q_EXPIRATION_UNKNOWN', parsed ? 'Expired source is retained as raw-only data.' : 'Expiration lacks an unambiguous supported UTC instant; retained as raw-only data.', 'warning'));
    }
  }
  if (family === 'graphiti') {
    const expired = member(body, 'expired_at');
    if (expired && expired.kind !== 'null') reasons.push(issue('Q_INVALIDATED', 'A graph edge with transaction invalidation remains raw-only data.', 'warning'));
    for (const field of ['valid_at', 'invalid_at'] as const) {
      const value = member(body, field);
      if (!value || value.kind === 'null') continue;
      const parsed = foreignInstant(value.value), at = BigInt(Date.parse(options.evaluatedAt)) * 1000000n;
      if (parsed === undefined || (field === 'valid_at' ? parsed > at : parsed <= at)) reasons.push(issue('Q_TEMPORAL', 'A graph edge outside the preview validity window or with an unsupported instant remains raw-only data; explicit RFC3339 offsets or Z are required.', 'warning'));
    }
    reasons.push(issue('W_GRAPH_SEMANTICS', 'Only fact text is projected. Foreign graph endpoints, episodes, embeddings and temporal intervals are not installed; future expiry needs a host freshness policy.', 'warning'));
  }
  if (family === 'hindsight') {
    const state = member(body, 'state'), invalidated = member(body, 'invalidated_at');
    if (state?.value !== 'valid' || invalidated && invalidated.kind !== 'null' && invalidated.value !== '') reasons.push(issue('Q_CURATION', 'Invalidated, missing or unknown Hindsight curation state remains raw-only; export explicit valid state before projecting assertions.', 'warning'));
    reasons.push(issue('W_FACT_SEMANTICS', 'Only fact text is projected. Foreign proof counts, source IDs, entities, event dates and observation models remain raw data without local evidence or profile authority.', 'warning'));
  }
  if (family === 'supermemory') {
    if (member(body, 'status')?.value !== 'done') reasons.push(issue('Q_DOCUMENT_STATE', 'A document without explicit completed processing remains raw-only source data.', 'warning'));
    const histories = member(body, 'memories');
    if (histories && histories.kind !== 'null' && (histories.kind !== 'array' || histories.elements.some(history => {
      const forgotten = member(history, 'isForgotten'), latest = member(history, 'isLatest');
      return history.kind !== 'object' || forgotten?.value !== false || latest?.value !== true;
    }))) reasons.push(issue('Q_EMBEDDED_HISTORY', 'Nested forgotten, non-current or ambiguous memory histories keep the entire source raw-only; no historical claim becomes advice.', 'warning'));
    reasons.push(issue('W_DOCUMENT_SEMANTICS', 'Only literal content is projected; URLs are never fetched. Foreign extracted memories, profiles, links, tags and connector synchronization are not recreated.', 'warning'));
  }
  if (family === 'langgraph') reasons.push(issue('W_STRUCTURED_VALUE', 'The entire JSON value is projected literally; no arbitrary property is selected as fact text. Foreign namespaces, indexing, TTL refresh, checkpoints and executable state are not installed.', 'warning'));
  return reasons;
}
function normalizeRecord(artifact: OwnedArtifact, artifactIndex: number, node: JsonSpanNode | undefined, pointer: string, options: NormalizedMigrationOptions): MutableRecord {
  const family = familyOf(artifact.profile), startByte = node?.startByte ?? 0, endByte = node?.endByte ?? artifact.bytes.length;
  const raw = artifact.bytes.subarray(startByte, endByte);
  const base: MutableRecord = { artifactIndex, pointer, startByte, endByte, rawBytes: raw.length, rawHash: hash(raw), family, profile: artifact.profile, ownerAssumed: false, disposition: 'invalid', trust: options.trust, visibility: 'private', originalTextBytes: 0, mappedTextBytes: 0, mappings: [], issues: [] };
  const fail = (code: string, message: string): MutableRecord => ({ ...base, issues: [issue(code, message)] });
  if (raw.length > options.limits.maxSourceBytes) return fail('E_SOURCE_LIMIT', 'The exact source unit exceeds the supported byte limit; it was not truncated or retained.');
  let rawText: string;
  try { rawText = decoder.decode(raw); } catch { return fail('E_UTF8', 'The source unit is not valid UTF-8.'); }
  let body: ObjectNode | undefined, externalId: string;
  if (node) {
    if (node.kind !== 'object') return fail('E_RECORD', 'The source record must be an object.');
    const id = member(node, family === 'langgraph' ? 'key' : family === 'graphiti' ? 'uuid' : 'id');
    if (!(id?.kind === 'string' && id.value.trim() && bytesOf(id.value) <= 1024 && !/[\u0000-\u001f\u007f]/u.test(id.value)) && !(family === 'mnemosyne' && id?.kind === 'number' && Number.isSafeInteger(id.value) && id.value >= 0 && canonical(id, artifact.bytes) === canonicalNumber(String(id.value)))) return fail('E_ID', 'A stable bounded external ID is required; numeric IDs must be exact nonnegative safe integers.');
    externalId = String(id!.value);
    if (family === 'langgraph') {
      const namespace = member(node, 'namespace');
      if (namespace?.kind !== 'array' || namespace.elements.length > 32 || namespace.elements.some(part => part.kind !== 'string' || !part.value.trim() || bytesOf(part.value) > 512 || /[\u0000-\u001f\u007f]/u.test(part.value))) return fail('E_NAMESPACE', 'LangGraph requires a bounded namespace array of literal strings; no path splitting or owner inference is performed.');
      externalId = JSON.stringify([namespace.value, externalId]);
    }
    if (family === 'graphiti') {
      const group = member(node, 'group_id');
      if (group?.kind !== 'string' || bytesOf(group.value) > 512 || /[\u0000-\u001f\u007f]/u.test(group.value)) return fail('E_GROUP', 'Graphiti requires its explicit group_id, including an empty default group if used upstream.');
      externalId = JSON.stringify([group.value, externalId]);
    }
    if (artifact.profile === 'mnemosyne-qdrant-scroll') {
      const payload = member(node, 'payload');
      if (payload?.kind !== 'object') return fail('E_RECORD', 'The Mnemosyne Qdrant profile requires an object payload.');
      body = payload;
      const memoryType = member(body, 'memory_type');
      if (!options.qdrantTextField && (memoryType?.kind !== 'string' || !MEMORY_TYPES.includes(memoryType.value as typeof MEMORY_TYPES[number]))) return fail('E_MAPPING_REQUIRED', 'An unrecognized Qdrant payload requires an explicit text-field mapping.');
    } else body = node;
  } else externalId = artifact.logicalPath!;
  base.externalId = externalId;
  const field = options.sourceOwner.field ?? (family === 'mnemosyne' ? 'agent' : family === 'mem0' ? 'user' : 'creator');
  const ownerKey = field === 'creator' ? 'creator_id' : artifact.profile === 'mnemosyne-memcell-array' ? `${field}Id` : `${field}_id`;
  // Only the original profiles publish these owner fields. Never interpret a
  // foreign arbitrary metadata key, namespace, graph group or container tag as one.
  const ownerNode = ['mnemosyne', 'mem0', 'letta'].includes(family) ? member(body, ownerKey) : undefined;
  let sourceOwner: string | undefined;
  if (!ownerNode || ownerNode.kind === 'null') { sourceOwner = options.sourceOwner.assumeMissing; base.ownerAssumed = sourceOwner !== undefined; }
  else if (ownerNode.kind === 'string' && ownerNode.value.trim() && bytesOf(ownerNode.value) <= 512 && !/[\u0000-\u001f\u007f]/u.test(ownerNode.value)) sourceOwner = ownerNode.value;
  else return fail('E_OWNER', 'Selected source ownership field has an invalid value.');
  if (sourceOwner === undefined) return fail('E_OWNER_MISSING', 'Missing source ownership requires an explicit selected export-scope assumption.');
  base.sourceOwner = sourceOwner;
  base.identity = migrationOriginIdentity({ family, sourceStore: options.sourceStore, collection: options.collection, sourceOwner, externalId });
  base.canonicalHash = node ? hash(canonical(node, artifact.bytes)) : base.rawHash;
  const textKey = family === 'mem0' ? 'memory' : family === 'letta' || family === 'langgraph' ? 'value' : family === 'graphiti' ? 'fact' : family === 'supermemory' ? 'content' : options.qdrantTextField && artifact.profile === 'mnemosyne-qdrant-scroll' ? options.qdrantTextField : 'text';
  base.mappings = mappingsFor(node, artifact.profile, textKey);
  if (!options.sourceOwner.allowedIds.includes(sourceOwner)) {
    base.disposition = 'excluded'; base.issues = [issue('X_OWNER', 'Source owner is outside the explicit selection; no source content is retained.', 'warning')]; return base;
  }
  const textNode = member(body, textKey);
  const text = family === 'langgraph' ? textNode?.kind === 'object' ? decoder.decode(artifact.bytes.subarray(textNode.startByte, textNode.endByte)) : undefined : node ? textNode?.kind === 'string' ? textNode.value : undefined : rawText;
  if (text === undefined) return fail('E_TEXT', family === 'supermemory' ? 'Supermemory requires string content; export documents.list with includeContent: true. Summaries, URLs in other fields and metadata are not a content substitute.' : family === 'langgraph' ? 'LangGraph Item.value must be a JSON object; checkpoint/state dumps and scalar values are unsupported.' : 'The selected profile requires its documented text field to contain a string.');
  base.originalTextBytes = bytesOf(text);
  const issues = lifecycle(body, family, options);
  if (rawText.includes('\0')) issues.push(issue('Q_NUL_SOURCE', 'Literal NUL source bytes require raw-only encoding controls; no active assertion is created.', 'warning'));
  if (!text.trim()) issues.push(issue('Q_EMPTY', 'Blank source assertions remain raw-only data; no nonempty fact is invented.', 'warning'));
  if (text.includes('\0')) issues.push(issue('Q_NUL_TEXT', 'A decoded assertion containing NUL remains raw-only data.', 'warning'));
  if (base.ownerAssumed) issues.push(issue('W_OWNER_ASSUMED', 'Source ownership is the caller-declared export scope, not independently authenticated.', 'warning'));
  const quarantine = issues.some(entry => entry.code.startsWith('Q_'));
  return { ...base, disposition: quarantine ? 'quarantine' : 'create', trust: quarantine ? 'untrusted' : options.trust, rawText, ...(quarantine ? {} : { text }), mappedTextBytes: quarantine ? 0 : bytesOf(text), issues };
}
function finalizeMappings(record: MutableRecord): void {
  const retained = record.disposition === 'create' || record.disposition === 'quarantine';
  record.mappings = record.mappings.map(mapping => !retained ? { ...mapping, status: 'not-retained', reason: record.disposition === 'unchanged' ? 'Equivalent source already has a retained representative; this serialization is not additionally stored.' : 'This source unit is not retained by the plan.' } : record.disposition === 'quarantine' && mapping.status === 'preserved-active' ? { ...mapping, status: 'preserved-raw-only', reason: 'Quarantined source data has no active observation.' } : mapping);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Pure preview: supplied bytes only, no files, network, database, tools or models. */
export function planMigration(artifacts: readonly MigrationArtifact[], suppliedOptions: MigrationPlanOptions): MigrationPlan {
  const options = normalizeOptions(suppliedOptions), owned = ownArtifacts(artifacts, options);
  const families = new Set(owned.map(artifact => familyOf(artifact.profile)));
  if (families.size !== 1) reject('E_OPTIONS', 'Use a separate plan for each source format family.');
  const family = [...families][0];
  if (family === 'mnemosyne' && !options.collection) reject('E_OPTIONS', 'Legacy Mnemosyne identities require the source collection.');
  if (family !== 'mnemosyne' && (options.collection !== undefined || options.qdrantTextField !== undefined)) reject('E_OPTIONS', 'Collection and Qdrant mappings apply only to legacy Mnemosyne.');
  const inputs: MigrationInputReport[] = [], records: MutableRecord[] = [];
  for (const [artifactIndex, artifact] of owned.entries()) {
    const base = { artifactIndex, name: artifact.name, profile: artifact.profile, ...(artifact.logicalPath === undefined ? {} : { logicalPath: artifact.logicalPath }), bytes: artifact.bytes.length, sha256: hash(artifact.bytes), ...(artifact.page === undefined ? {} : { page: artifact.page }) };
    if (artifact.profile === 'markdown') {
      if (records.length >= options.limits.maxRecords) reject('E_LIMIT', 'Source record count exceeds the migration limit.');
      records.push(normalizeRecord(artifact, artifactIndex, undefined, '', options));
      inputs.push({ ...base, recordCount: 1, framingBytes: 0, rejectedInputBytes: 0, issues: [] }); continue;
    }
    try {
      const parsed = parseJsonWithSpans(artifact.bytes, { maxInputBytes: options.limits.maxInputBytes });
      const selection = selectRecords(artifact, parsed.root);
      if (records.length + selection.nodes.length > options.limits.maxRecords) reject('E_LIMIT', 'Source record count exceeds the migration limit.');
      let rawBytes = 0;
      const inputRecords: MutableRecord[] = [];
      for (const [index, node] of selection.nodes.entries()) { rawBytes += node.endByte - node.startByte; inputRecords.push(normalizeRecord(artifact, artifactIndex, node, `${selection.prefix}/${index}`, options)); }
      records.push(...inputRecords);
      inputs.push({ ...base, recordCount: selection.nodes.length, framingBytes: artifact.bytes.length - rawBytes, rejectedInputBytes: 0, issues: [], ...(selection.reportedTotal === undefined ? {} : { reportedTotal: selection.reportedTotal }), ...(selection.hasNext === undefined ? {} : { hasNext: selection.hasNext }), ...(selection.hasPrevious === undefined ? {} : { hasPrevious: selection.hasPrevious }), ...(selection.offset === undefined ? {} : { offset: selection.offset, pageLimit: selection.pageLimit }) });
    } catch (error) {
      if (error instanceof MigrationPlanError) throw error;
      const failure: MigrationIssue = error instanceof JsonSpanError ? { ...issue(error.code, 'JSON input was rejected; no source content from this input is retained.'), byteOffset: error.byteOffset } : error && typeof error === 'object' && 'code' in error && error.code === 'E_PROFILE' ? error as MigrationIssue : issue('E_INPUT', 'Source input could not be parsed safely.');
      inputs.push({ ...base, recordCount: 0, framingBytes: 0, rejectedInputBytes: artifact.bytes.length, ...(failure.byteOffset === undefined ? {} : { unparsedBytes: artifact.bytes.length - Math.min(artifact.bytes.length, failure.byteOffset) }), issues: [failure] });
    }
  }
  const groups = new Map<string, MutableRecord[]>();
  for (const record of records) if (record.identity && ['create', 'quarantine'].includes(record.disposition)) groups.set(record.identity, [...groups.get(record.identity) ?? [], record]);
  for (const group of groups.values()) {
    const conflicted = new Set(group.map(record => record.canonicalHash)).size > 1;
    for (const [index, record] of group.entries()) if (conflicted || index > 0) {
      record.disposition = conflicted ? 'conflict' : 'unchanged';
      delete record.rawText; delete record.text; record.mappedTextBytes = 0;
      record.issues = [...record.issues, issue(conflicted ? 'E_IDENTITY_CONFLICT' : 'W_DUPLICATE_RECORD', conflicted ? 'The same stable source identity has different canonical payloads; no revision was selected.' : 'Equivalent source already has a representative in this plan; newly supplied serialization is not retained.', conflicted ? 'error' : 'warning')];
    }
  }
  records.forEach(finalizeMappings);
  const counts = { create: 0, unchanged: 0, quarantine: 0, excluded: 0, conflict: 0, invalid: 0 };
  const fieldCounts: Record<MigrationFieldStatus, number> = { 'preserved-active': 0, 'preserved-raw-only': 0, downgraded: 0, 'not-retained': 0, unsupported: 0 };
  const accounting = { suppliedBytes: inputs.reduce((sum, input) => sum + input.bytes, 0), retainedRawBytes: 0, excludedRawBytes: 0, invalidRawBytes: 0, conflictRawBytes: 0, duplicateRawBytesNotRetained: 0, framingBytesNotRetained: inputs.reduce((sum, input) => sum + input.framingBytes, 0), rejectedInputBytes: inputs.reduce((sum, input) => sum + input.rejectedInputBytes, 0), originalTextBytes: 0, mappedTextBytes: 0 };
  for (const record of records) {
    counts[record.disposition]++; record.mappings.forEach(mapping => fieldCounts[mapping.status]++);
    accounting.originalTextBytes += record.originalTextBytes; accounting.mappedTextBytes += record.mappedTextBytes;
    const key = record.disposition === 'create' || record.disposition === 'quarantine' ? 'retainedRawBytes' : record.disposition === 'excluded' ? 'excludedRawBytes' : record.disposition === 'invalid' ? 'invalidRawBytes' : record.disposition === 'conflict' ? 'conflictRawBytes' : 'duplicateRawBytesNotRetained';
    accounting[key] += record.rawBytes;
  }
  const suppliedUniqueIds = new Set(records.filter(record => record.identity).map(record => record.identity!)).size;
  const upstreamTotals = [...new Set(inputs.flatMap(input => input.reportedTotal === undefined ? [] : [input.reportedTotal]))].sort((a, b) => a - b);
  const reasons: string[] = [], reportIssues: MigrationIssue[] = [];
  let completeness: 'complete' | 'partial' | 'unknown' = 'unknown';
  const pages = inputs.filter(input => input.page !== undefined);
  if (family === 'markdown') { completeness = 'complete'; reasons.push('Complete only for the explicitly supplied logical files; no filesystem inventory is inferred.'); }
  else if (pages.length === inputs.length) {
    const totals = new Set(pages.map(input => input.page!.totalPages)), indexes = new Set(pages.map(input => input.page!.index));
    const total = pages[0]?.page?.totalPages ?? 0;
    if (totals.size === 1 && indexes.size === inputs.length && indexes.size === total) { completeness = 'complete'; reasons.push('The caller declared and supplied every page index.'); }
    else { completeness = 'partial'; reasons.push('Caller page declarations are inconsistent, duplicated or incomplete.'); }
  } else reasons.push('No complete caller page inventory was supplied; an array or terminal page alone does not prove a full export.');
  for (const input of inputs) if (input.hasNext !== undefined) {
    if (input.page && input.hasNext === (input.page.index === input.page.totalPages - 1)) { completeness = 'partial'; reasons.push('An upstream continuation marker contradicts the declared page position.'); }
    else if (!input.page && input.hasNext) { completeness = 'partial'; reasons.push('An upstream continuation marker declares additional records; no URL was followed.'); }
  }
  for (const input of inputs) if (input.hasPrevious !== undefined) {
    if (input.page && input.hasPrevious !== (input.page.index > 0)) { completeness = 'partial'; reasons.push('An upstream previous-page marker contradicts the declared page position.'); }
    else if (!input.page && input.hasPrevious) { completeness = 'partial'; reasons.push('An upstream previous-page marker declares earlier records; no URL was followed.'); }
  }
  const offsetPages = inputs.filter(input => input.offset !== undefined).sort((a, b) => a.offset! - b.offset!);
  if (offsetPages.length) {
    let expectedOffset = 0;
    for (const input of offsetPages) {
      if (input.offset !== expectedOffset) { completeness = 'partial'; reasons.push('Upstream offset ranges have missing or overlapping records; supply contiguous unmodified pages.'); }
      expectedOffset = input.offset! + input.recordCount;
    }
  }
  if (upstreamTotals.length > 1 || upstreamTotals.length === 1 && upstreamTotals[0] !== suppliedUniqueIds) { completeness = 'partial'; reasons.push('Reported upstream totals do not agree with the supplied unique source identities.'); }
  if (family !== 'markdown' && new Set(inputs.map(input => `${input.profile}:${input.sha256}`)).size < inputs.length) { completeness = 'partial'; reasons.push('An identical input page was supplied more than once.'); }
  if (counts.excluded) { completeness = 'partial'; reasons.push('Foreign source owners were explicitly excluded from retention.'); }
  if (counts.invalid || counts.conflict || inputs.some(input => input.issues.some(entry => entry.severity === 'error'))) { completeness = 'partial'; reasons.push('Invalid inputs or conflicting source records prevent a complete migration.'); }
  if (completeness !== 'complete' && !options.acknowledgePartial) reportIssues.push(issue('E_PARTIAL_ACK_REQUIRED', 'Explicit acknowledgement is required for this partial or unknown source selection.'));
  const fatal = counts.invalid > 0 || counts.conflict > 0 || inputs.some(input => input.issues.some(entry => entry.severity === 'error')) || reportIssues.some(entry => entry.severity === 'error');
  const retained = records.filter(record => record.disposition === 'create' || record.disposition === 'quarantine');
  const empty = retained.filter(record => !record.rawText!.trim()).length;
  const encoded = retained.filter(record => !record.rawText!.trim() || record.rawText!.includes('\0')).length;
  const report = { destinationInspected: false as const, readyToApply: !fatal, recordsSeen: records.length, counts, completeness: { status: completeness, reasons: [...new Set(reasons)], suppliedUniqueIds, upstreamTotals }, accounting, proposedSources: retained.length - encoded, proposedObservations: counts.create, proposedEmptySourceControls: empty, proposedEncodedSourceControls: encoded, proposedTextStorageBytes: accounting.retainedRawBytes + accounting.mappedTextBytes, fieldCounts, issues: reportIssues };
  const unsigned = { version: 1 as const, parserVersion: 'mnemosyne-migration-v1' as const, options, inputs, records, report };
  return freeze({ ...unsigned, planHash: hash(JSON.stringify(unsigned)) });
}
