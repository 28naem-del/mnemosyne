import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../local/validation.js';
import { MIGRATION_PROFILES } from './types.js';

export const migrationHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const bytesHash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reference = z.object({ id: z.string().uuid(), fingerprint: digest }).strict();
export type Reference = z.infer<typeof reference>;
const base = { version: z.literal(1), key: digest };
const counts = z.object({ create: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative(), quarantine: z.number().int().nonnegative(), excluded: z.number().int().nonnegative(), conflict: z.number().int().nonnegative(), invalid: z.number().int().nonnegative() }).strict();
export const bindingSchema = z.object({
  ...base, type: z.literal('binding'), canonicalHash: digest, rawHash: digest, rawBytes: z.number().int().min(0).max(65536),
  trust: z.enum(['untrusted', 'observed']), disposition: z.enum(['create', 'quarantine']), storage: z.enum(['capture', 'pages']),
  origin: z.object({ inputHash: digest, startByte: z.number().int().nonnegative(), endByte: z.number().int().nonnegative(), profile: z.enum(MIGRATION_PROFILES) }).strict(),
  source: reference.optional(), rawPages: z.array(reference).max(4), projection: reference.optional(), textHash: digest.optional(),
}).strict();
export const rawPageSchema = z.object({ ...base, type: z.literal('raw-page'), identity: digest, rawHash: digest, index: z.number().int().min(0).max(3), base64: z.string().max(21848) }).strict();
export const sourceEntrySchema = z.object({ identity: digest, binding: reference, created: z.boolean() }).strict();
export const journalPageSchema = z.object({ ...base, type: z.literal('journal-page'), batchKey: digest, index: z.number().int().min(0).max(999), sources: z.array(sourceEntrySchema).max(32), created: z.array(reference).max(256) }).strict();
export const batchSchema = z.object({
  ...base, type: z.literal('batch'), planHash: digest, state: z.enum(['applied', 'rolled-back']), counts,
  rollbackOf: reference.optional(),
  sourceCount: z.number().int().min(0).max(1000), createdCount: z.number().int().min(0).max(10000),
  retainedRawBytes: z.number().int().nonnegative().max(1000 * 65536), newlyRetainedRawBytes: z.number().int().nonnegative().max(4194304),
  suppliedSerializationBytesNotRetained: z.number().int().nonnegative().max(4194304),
  journalPages: z.array(reference).max(32), inputHashes: z.array(digest).max(1000),
}).strict();
export const tombstoneSchema = z.object({ ...base, type: z.literal('tombstone') }).strict();
export const controlSchema = z.discriminatedUnion('type', [bindingSchema, rawPageSchema, journalPageSchema, batchSchema, tombstoneSchema]);
export type Binding = z.infer<typeof bindingSchema>;
export type Batch = z.infer<typeof batchSchema>;
export type JournalPage = z.infer<typeof journalPageSchema>;
export type SourceEntry = z.infer<typeof sourceEntrySchema>;
export type Control = z.infer<typeof controlSchema>;
export const controlMetadata = (type: Control['type'], key: string) => ({ migrationVersion: '1', migrationType: type, migrationKey: key, advisory: false });
export const controlUri = (type: Control['type'], key: string): string => `migration:v1:${type}:${key}`;
export const pageKey = (identity: string, rawHash: string, index: number): string => migrationHash(['raw-page', identity, rawHash, index]);
export const journalKey = (batchKey: string, index: number): string => migrationHash(['journal-page', batchKey, index]);
