import { createHash } from 'node:crypto';
import type { LocalMemory, MemoryRecord } from '../local/index.js';
import { canonical } from '../local/validation.js';
import { controlMetadata, controlSchema, controlUri, digest, migrationHash, tombstoneSchema } from './journal.js';
import type { MigrationFamily } from './types.js';

/** Literal upstream identity, independent of destination scope and export filenames. */
export interface MigrationOrigin {
  family: MigrationFamily;
  sourceStore: string;
  collection?: string;
  sourceOwner: string;
  /** LangGraph: JSON.stringify([namespace, key]); Graphiti: JSON.stringify([group_id, uuid]). */
  externalId: string;
}
export interface MigrationOriginOptions { maxScanRecords?: number }
export class MigrationOriginError extends Error {
  constructor(readonly code: 'E_INPUT' | 'E_LIMIT' | 'E_STATE', message: string) { super(`${code}: ${message}`); this.name = 'MigrationOriginError'; }
}
function fail(code: MigrationOriginError['code'], message: string): never { throw new MigrationOriginError(code, message); }
function plain(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) fail('E_INPUT', 'Expected an origin data object.');
  if (Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => !keys.includes(key) || !('value' in descriptor))) fail('E_INPUT', 'Unexpected origin fields or accessors.');
  return value as Record<string, unknown>;
}
function label(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxBytes || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value).toString('utf8') !== value) fail('E_INPUT', 'Invalid bounded origin identifier.');
  return value;
}
/** Byte-for-byte compatible with the original full-migration identity formula. */
export function migrationOriginIdentity(origin: MigrationOrigin): string {
  const data = plain(origin, ['family', 'sourceStore', 'collection', 'sourceOwner', 'externalId']);
  if (!['mnemosyne', 'markdown', 'mem0', 'letta', 'langgraph', 'graphiti', 'hindsight', 'supermemory'].includes(data.family as string)) fail('E_INPUT', 'Unknown migration source family.');
  const store = label(data.sourceStore, 512), owner = label(data.sourceOwner, 512), externalId = label(data.externalId, 65536);
  const collection = data.collection === undefined ? undefined : label(data.collection, 512);
  if (data.family === 'mnemosyne' && collection === undefined) fail('E_INPUT', 'Mnemosyne source identity requires a collection.');
  return createHash('sha256').update(JSON.stringify([data.family, store, data.family === 'mnemosyne' ? collection : '', owner, externalId])).digest('hex');
}
function identityOf(origin: MigrationOrigin | string): string {
  if (typeof origin !== 'string') return migrationOriginIdentity(origin);
  if (!digest.safeParse(origin).success) fail('E_INPUT', 'Expected a source identity digest.');
  return origin;
}
function scanLimit(options: MigrationOriginOptions): number {
  const data = plain(options, ['maxScanRecords']), value = data.maxScanRecords ?? 10000;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100000) fail('E_LIMIT', 'Origin scan budget must be an integer from 1 to 100000.');
  return value;
}
function envelope(memory: LocalMemory, record: MemoryRecord): void {
  if (record.workspaceId !== memory.workspaceId || record.agentId !== memory.agentId || record.visibility !== 'private' || record.trust !== 'untrusted' || record.kind !== 'observation' || record.evidence || record.key || record.validFrom || record.validUntil || record.supersedes) fail('E_STATE', 'Invalid source deletion control envelope.');
}
function state(memory: LocalMemory, identity: string, limit: number): { tombstone?: MemoryRecord; runtimeForgotten: boolean; scanned: number } {
  let scanned = 0;
  const read = (metadata: Record<string, string>): MemoryRecord[] => {
    const records: MemoryRecord[] = []; let cursor: string | undefined;
    do {
      const page = memory.list({ metadata, includeInactive: true, includeUntrusted: true, limit: Math.min(1000, limit), cursor });
      scanned += page.items.length;
      if (scanned > limit || (page.nextCursor && scanned >= limit)) fail('E_LIMIT', 'Source deletion inventory exceeds its scan budget.');
      records.push(...page.items.filter(record => record.agentId === memory.agentId)); cursor = page.nextCursor;
    } while (cursor);
    return records;
  };
  let tombstone: MemoryRecord | undefined;
  for (const record of read({ migrationVersion: '1', migrationKey: identity })) {
    let data;
    try { data = controlSchema.parse(JSON.parse(record.text)); } catch { return fail('E_STATE', 'Invalid persisted source deletion control.'); }
    if (data.key !== identity || canonical(record.metadata) !== canonical(controlMetadata(data.type, data.key)) || canonical(record.source) !== canonical({ uri: controlUri(data.type, data.key) })) fail('E_STATE', 'Invalid persisted origin control identity.');
    if (data.type !== 'tombstone') continue;
    envelope(memory, record);
    if (tombstone || record.status !== 'active' || record.dependencies.length) fail('E_STATE', 'Conflicting or modified source deletion controls.');
    tombstone = record;
  }
  // Direct runtime erasure must block both ingestion paths. A progressive
  // document has a document-wide tombstone; a full import has a capture one.
  const documentIdentity = migrationHash(['document', `bridge:${identity}`]);
  const captureKey = `capture:${migrationHash(['generic', `migration:${identity}`, 'raw'])}`;
  let runtimeForgotten = false;
  const selectors: Record<string, string>[] = [{ documentIdentity }, { identity: migrationHash(captureKey) }];
  for (const selector of selectors) {
    const runtimeRows = read({ runtimeType: 'tombstone', ...selector });
    for (const record of runtimeRows) {
      envelope(memory, record);
      const value = record.metadata;
      const expectedMetadata = { runtimeType: 'tombstone', identity: value.identity, sourceId: value.sourceId, advisory: false, ...('documentIdentity' in selector ? { documentIdentity } : {}) };
      if (record.status !== 'active' || record.dependencies.length || !digest.safeParse(value.identity).success || typeof value.sourceId !== 'string' || !value.sourceId || canonical(value) !== canonical(expectedMetadata) || canonical(record.source) !== canonical({ uri: `runtime:tombstone:${value.identity}` })) fail('E_STATE', 'Invalid runtime source deletion control.');
    }
    runtimeForgotten ||= runtimeRows.length > 0;
  }
  return { tombstone, runtimeForgotten, scanned };
}
/** Scope-local privacy state shared by full and progressive migration. */
export function isMigrationOriginForgotten(memory: LocalMemory, origin: MigrationOrigin | string, options: MigrationOriginOptions = {}): boolean {
  const identity = identityOf(origin), limit = scanLimit(options);
  return memory.atomic(() => { const found = state(memory, identity, limit); return !!found.tombstone || found.runtimeForgotten; });
}
/** Registers replay protection only. Use forgetMigrationOrigin to erase existing copies too. */
export function registerMigrationOriginForgotten(memory: LocalMemory, origin: MigrationOrigin | string, options: MigrationOriginOptions = {}): { identity: string; recordId: string; created: boolean } {
  const identity = identityOf(origin), limit = scanLimit(options);
  return memory.atomic(() => {
    const found = state(memory, identity, limit);
    if (found.tombstone) return { identity, recordId: found.tombstone.id, created: false };
    if (found.scanned >= limit) fail('E_LIMIT', 'Source deletion control would exceed its scan budget.');
    const data = tombstoneSchema.parse({ version: 1, type: 'tombstone', key: identity });
    const record = memory.store({ text: JSON.stringify(data), kind: 'observation', trust: 'untrusted', visibility: 'private', source: { uri: controlUri(data.type, identity) }, metadata: controlMetadata(data.type, identity), idempotencyKey: `migration:tombstone:${identity}` });
    envelope(memory, record);
    if (record.status !== 'active' || record.dependencies.length) fail('E_STATE', 'Source deletion control was previously changed.');
    return { identity, recordId: record.id, created: true };
  });
}
