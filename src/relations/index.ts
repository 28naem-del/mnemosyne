import { createHash } from 'node:crypto';
import type { LocalMemory, MemoryRecord, MemorySource, MemoryVisibility } from '../local/index.js';
import * as v from '../local/validation.js';

const normalize = (name: string): string => name.normalize('NFKC').trim().toLocaleLowerCase('en-US');
export interface EntityInput { name: string; type: string; aliases?: string[]; source: MemorySource; evidenceIds?: string[]; visibility?: MemoryVisibility }
export interface RelationPath { entity: MemoryRecord; edges: MemoryRecord[]; evidenceIds: string[] }

/** Typed, evidence-bound graph over the same canonical records as ordinary recall. */
export class MemoryRelations {
  constructor(readonly memory: LocalMemory, readonly maxScanRecords = 10_000) {
    v.limit(maxScanRecords, 10_000, 100_000);
  }

  #records(component: string, time: { asOf?: string; knownAt?: string } = {}): MemoryRecord[] {
    const records: MemoryRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = this.memory.list({ limit: Math.min(1000, this.maxScanRecords - records.length), cursor, metadata: { component }, includeInactive: time.asOf !== undefined || time.knownAt !== undefined });
      records.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && records.length >= this.maxScanRecords) throw new Error('Graph scan budget exceeded; use a narrower workspace');
    } while (cursor);
    return records.flatMap(record => {
      const projected = this.memory.isEligible(record.id, time) ? this.memory.getAt(record.id, time) : null;
      return projected ? [projected] : [];
    });
  }

  entity(input: EntityInput): MemoryRecord {
    const obj = v.object(input, 'entity');
    v.keys(obj, ['name', 'type', 'aliases', 'source', 'evidenceIds', 'visibility'], 'entity');
    const name = v.string(input.name, 'name', 256);
    const type = v.string(input.type, 'type', 160);
    const aliases = [...new Set([name, ...v.strings(input.aliases ?? [], 'aliases', 32, 256)].map(normalize))];
    const evidenceIds = v.strings(input.evidenceIds ?? [], 'evidenceIds', 64);
    return this.memory.store({ kind: 'fact', trust: 'observed', text: `${name} (${type}); aliases: ${aliases.join(', ')}`,
      source: input.source, dependencies: evidenceIds, visibility: input.visibility,
      metadata: { component: 'entity', name, type, aliases } });
  }

  resolve(name: string, type?: string): { matches: MemoryRecord[]; ambiguous: boolean } {
    const alias = normalize(v.string(name, 'name', 256));
    if (type !== undefined) v.string(type, 'type', 160);
    const matches = this.#records('entity').filter(record => (!type || record.metadata.type === type)
      && Array.isArray(record.metadata.aliases) && record.metadata.aliases.includes(alias));
    // Equal names are not proof of identical identity. Expose ambiguity instead of merging.
    return { matches, ambiguous: matches.length > 1 };
  }

  relate(input: { fromId: string; toId: string; predicate: string; evidenceIds: string[]; source: MemorySource; visibility?: MemoryVisibility; validFrom?: string; validUntil?: string }): MemoryRecord {
    const obj = v.object(input, 'relation');
    v.keys(obj, ['fromId', 'toId', 'predicate', 'evidenceIds', 'source', 'visibility', 'validFrom', 'validUntil'], 'relation');
    const predicate = v.string(input.predicate, 'predicate', 160);
    const evidence = v.strings(input.evidenceIds, 'evidenceIds', 60);
    if (!evidence.length) throw new Error('A relation needs source evidence');
    const from = this.memory.get(input.fromId), to = this.memory.get(input.toId);
    for (const entity of [from, to]) if (!entity || entity.metadata.component !== 'entity' || !this.memory.isEligible(entity.id)) throw new Error('Relation endpoint unavailable or ambiguous');
    const dependencies = [...new Set([input.fromId, input.toId, ...evidence])];
    return this.memory.store({ text: `${from!.metadata.name} ${predicate} ${to!.metadata.name}`, kind: 'fact', trust: 'observed',
      source: input.source, visibility: input.visibility, dependencies, validFrom: input.validFrom, validUntil: input.validUntil,
      metadata: { component: 'relation', fromId: input.fromId, toId: input.toId, predicate },
      idempotencyKey: `relation:${createHash('sha256').update(v.canonical(input)).digest('hex')}` });
  }

  traverse(input: { entityId: string; maxDepth?: number; maxNodes?: number; predicates?: string[]; direction?: 'out' | 'in' | 'both'; asOf?: string; knownAt?: string }): RelationPath[] {
    const obj = v.object(input, 'traversal');
    v.keys(obj, ['entityId', 'maxDepth', 'maxNodes', 'predicates', 'direction', 'asOf', 'knownAt'], 'traversal');
    const depth = v.limit(input.maxDepth, 2, 4), maxNodes = v.limit(input.maxNodes, 50, 200);
    const predicates = v.strings(input.predicates ?? [], 'predicates', 32, 160);
    const direction = v.enumeration(input.direction ?? 'both', ['out', 'in', 'both'] as const, 'direction');
    const time = { ...(input.asOf === undefined ? {} : { asOf: v.timestamp(input.asOf, 'asOf') }), ...(input.knownAt === undefined ? {} : { knownAt: v.timestamp(input.knownAt, 'knownAt') }) };
    const start = this.memory.getAt(input.entityId, time);
    if (!start || start.metadata.component !== 'entity' || !this.memory.isEligible(start.id, time)) throw new Error('Entity unavailable');
    const edges = this.#records('relation', time).filter(edge => !predicates.length || predicates.includes(String(edge.metadata.predicate)));
    const queue: { id: string; path: MemoryRecord[] }[] = [{ id: start.id, path: [] }];
    const seen = new Set([start.id]);
    const result: RelationPath[] = [];
    for (let i = 0; i < queue.length && result.length < maxNodes; i++) {
      const current = queue[i];
      if (current.path.length >= depth) continue;
      for (const edge of edges) {
        const next = direction !== 'in' && edge.metadata.fromId === current.id ? edge.metadata.toId
          : direction !== 'out' && edge.metadata.toId === current.id ? edge.metadata.fromId : undefined;
        if (typeof next !== 'string' || seen.has(next)) continue;
        const entity = this.memory.getAt(next, time);
        if (!entity || !this.memory.isEligible(entity.id, time)) continue;
        seen.add(next);
        const path = [...current.path, edge];
        result.push({ entity, edges: path, evidenceIds: [...new Set(path.flatMap(item => item.dependencies))] });
        queue.push({ id: next, path });
        if (result.length >= maxNodes) break;
      }
    }
    return result;
  }
}
