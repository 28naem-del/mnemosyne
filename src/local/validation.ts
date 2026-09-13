import type { JsonValue, MemoryKind, MemorySource, StoreMemoryInput } from './types.js';

export const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'decision', 'procedure', 'observation', 'checkpoint'];

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

export function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${label} field: ${key}`);
  }
}

export function string(value: unknown, label: string, maxBytes = 512): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) {
    throw new TypeError(`${label} must be nonempty text of at most ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

export function enumeration<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`Invalid ${label}`);
  return value as T;
}

export function limit(value: unknown, fallback: number, max = 100): number {
  const actual = value === undefined ? fallback : value;
  if (typeof actual !== 'number' || !Number.isSafeInteger(actual) || actual < 1 || actual > max) {
    throw new TypeError(`limit must be an integer between 1 and ${max}`);
  }
  return actual;
}

export function boolean(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError('Expected boolean');
  return value;
}

export function strings(value: unknown, label: string, maxItems = 64, maxBytes = 160): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${label} must be an array of at most ${maxItems} strings`);
  return value.map((entry) => string(entry, label, maxBytes));
}

export function timestamp(value: unknown, label: string): string {
  const result = string(value, label, 40);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result) throw new TypeError(`${label} must be an ISO timestamp`);
  return result;
}

export function source(value: unknown): MemorySource {
  const input = object(value, 'source');
  keys(input, ['uri', 'author', 'observedAt', 'revision'], 'source');
  return {
    uri: string(input.uri, 'source.uri', 2048),
    ...(input.author === undefined ? {} : { author: string(input.author, 'source.author') }),
    ...(input.observedAt === undefined ? {} : { observedAt: timestamp(input.observedAt, 'source.observedAt') }),
    ...(input.revision === undefined ? {} : { revision: string(input.revision, 'source.revision', 1024) }),
  };
}

export function metadata(value: unknown): Record<string, JsonValue> {
  const input = object(value, 'metadata');
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 5000 || depth > 10) throw new TypeError('metadata is too complex');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (item.includes('\0')) throw new TypeError('metadata cannot contain NUL');
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || !item || seen.has(item)) throw new TypeError('metadata must contain finite, acyclic JSON values');
    seen.add(item);
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry, depth + 1);
    } else {
      const map = object(item, 'metadata entry');
      for (const [key, entry] of Object.entries(map)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('Unsafe metadata key');
        visit(entry, depth + 1);
      }
    }
    seen.delete(item);
  };
  visit(input, 0);
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 32768) throw new TypeError('metadata exceeds 32768 bytes');
  return JSON.parse(serialized) as Record<string, JsonValue>;
}

export function checkpointState(value: unknown): Record<string, JsonValue> {
  const input = object(value, 'checkpoint state');
  keys(input, ['taskId', 'goal', 'completed', 'pending', 'decisions', 'constraints', 'artifacts', 'rejectedApproaches', 'nextAction'], 'checkpoint state');
  return {
    taskId: string(input.taskId, 'taskId', 160),
    goal: string(input.goal, 'goal', 4096),
    completed: strings(input.completed, 'completed', 100, 2048),
    pending: strings(input.pending, 'pending', 100, 2048),
    decisions: strings(input.decisions, 'decisions', 100, 2048),
    constraints: strings(input.constraints, 'constraints', 100, 2048),
    artifacts: strings(input.artifacts, 'artifacts', 100, 2048),
    ...(input.rejectedApproaches === undefined ? {} : { rejectedApproaches: strings(input.rejectedApproaches, 'rejectedApproaches', 100, 2048) }),
    nextAction: string(input.nextAction, 'nextAction', 4096),
  };
}

export function storeInput(value: unknown): Required<Pick<StoreMemoryInput, 'text' | 'kind' | 'visibility' | 'trust' | 'source' | 'dependencies' | 'metadata'>> & Pick<StoreMemoryInput, 'evidence' | 'key' | 'idempotencyKey' | 'validFrom' | 'validUntil'> {
  const input = object(value, 'memory');
  keys(input, ['text', 'kind', 'visibility', 'trust', 'source', 'evidence', 'key', 'dependencies', 'metadata', 'idempotencyKey', 'validFrom', 'validUntil'], 'memory');
  const dependencies = strings(input.dependencies === undefined ? [] : input.dependencies, 'dependencies');
  if (new Set(dependencies).size !== dependencies.length) throw new TypeError('Duplicate dependencies');
  const trust = enumeration(input.trust === undefined ? 'untrusted' : input.trust, ['untrusted', 'observed', 'verified'] as const, 'trust');
  const evidence = input.evidence === undefined ? undefined : string(input.evidence, 'evidence', 8192);
  if (trust === 'verified' && !evidence) throw new TypeError('Verified memory requires evidence');
  const text = string(input.text, 'text', 65536);
  const kind = enumeration(input.kind === undefined ? 'fact' : input.kind, KINDS, 'kind');
  const meta = metadata(input.metadata === undefined ? {} : input.metadata);
  if (kind === 'checkpoint') {
    const state = checkpointState(meta.checkpoint);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new TypeError('Checkpoint text must contain its typed JSON state'); }
    if (canonical(parsed) !== canonical(state)) throw new TypeError('Checkpoint text and metadata state must agree');
  }
  const validFrom = input.validFrom === undefined ? undefined : timestamp(input.validFrom, 'validFrom');
  const validUntil = input.validUntil === undefined ? undefined : timestamp(input.validUntil, 'validUntil');
  if (validFrom && validUntil && validUntil <= validFrom) throw new TypeError('validUntil must follow validFrom');
  return {
    text,
    kind,
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil }),
    visibility: enumeration(input.visibility === undefined ? 'private' : input.visibility, ['private', 'workspace'] as const, 'visibility'),
    trust,
    source: source(input.source),
    ...(evidence === undefined ? {} : { evidence }),
    ...(input.key === undefined ? {} : { key: string(input.key, 'key', 256) }),
    dependencies,
    metadata: meta,
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: string(input.idempotencyKey, 'idempotencyKey', 256) }),
  };
}

/** Object key ordering is immaterial for idempotency; array ordering is preserved. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
