import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { LocalMemory, type MemoryRecord } from '../local/index.js';
import { canonical } from '../local/validation.js';
import { MemoryRuntime } from '../runtime/index.js';

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const text = (bytes: number) => z.string().min(1).refine(value => !!value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= bytes);
const id = text(160), digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const age = z.number().int().min(1).max(3650 * 86400_000);
const watchSchema = z.object({ memoryId: id, maxAgeMs: age, priority: z.number().int().min(0).max(100).default(0) }).strict();
const observationSchema = z.object({ status: z.enum(['confirmed', 'changed', 'unavailable']), evidence: text(8192), verifier: text(512), sourceRevision: text(1024).optional() }).strict();
const watchMetadata = watchSchema.extend({ mnemosyneMaintenance: z.literal('v1'), runtimeType: z.literal('maintenance-watch'), advisory: z.literal(false) }).strict();
const checkMetadata = z.object({ mnemosyneMaintenance: z.literal('v1'), runtimeType: z.literal('maintenance-check'), advisory: z.literal(false), memoryId: id, watchId: id, checkedAt: instant, lastConfirmedAt: instant.optional(), targetFingerprint: digest, status: observationSchema.shape.status, evidence: text(8192), verifier: text(512), sourceRevision: text(1024).optional(), correctionReason: text(4096).optional() }).strict();
const ticketRecord = z.object({ id, fingerprint: digest, stateHash: digest, outcomes: z.object({ successes: z.number().int().nonnegative(), failures: z.number().int().nonnegative() }).strict() }).strict();
const ticketSchema = z.object({ version: z.literal(1), workspaceId: id, agentId: id, actionHash: digest, nonce: z.string().uuid(), createdAt: instant, expiresAt: instant, requireWatched: z.boolean(), roots: z.array(id).min(1).max(64), records: z.array(ticketRecord).min(1).max(2048), signature: digest }).strict();

export type FreshnessStatus = 'unwatched' | 'fresh' | 'needs-check' | 'stale' | 'source-changed' | 'unavailable' | 'ineligible' | 'missing' | 'clock-skew';
export interface FreshnessAssessment {
  memoryId: string;
  status: FreshnessStatus;
  /** Includes the full target, watch policy and latest source check revisions. */
  stateHash: string;
  fingerprint?: string;
  watchId?: string;
  lastCheckedAt?: string;
  lastConfirmedAt?: string;
  nextCheckAt?: string;
  priority: number;
}
export type SourceCheckObservation = z.infer<typeof observationSchema>;
export type MemoryReadSet = z.infer<typeof ticketSchema>;
type Watch = { record: MemoryRecord; data: z.infer<typeof watchMetadata> };
type Check = { record: MemoryRecord; data: z.infer<typeof checkMetadata> };
type Inventory = { watches: Map<string, Watch>; checks: Map<string, Check> };

export interface MaintenanceOptions {
  now?: () => Date;
  /** Fail closed if the owned/visible control inventory exceeds this bound. */
  maxScanRecords?: number;
}
export interface SourceCheckProbe {
  (request: { memory: MemoryRecord; freshness: FreshnessAssessment }, options: { signal: AbortSignal }): Promise<SourceCheckObservation>;
}

/**
 * Explicit source freshness and short-lived, action-bound dependency read sets.
 * No scheduler, filesystem discovery, URL fetching, model calls or automatic
 * factual rewriting. Controllers supply probes and own external action policy.
 */
export class MemoryMaintenance {
  readonly runtime: MemoryRuntime;
  readonly memory: LocalMemory;
  readonly #now: () => Date;
  readonly #scanLimit: number;
  readonly #ticketKey = randomBytes(32);
  #latestTime = -Infinity;
  #clockReversed = false;

  constructor(runtime: MemoryRuntime, options: MaintenanceOptions = {}) {
    if (!(runtime instanceof MemoryRuntime) || !(runtime.memory instanceof LocalMemory)) throw new TypeError('Maintenance requires a MemoryRuntime with LocalMemory');
    const parsed = z.object({ now: z.custom<() => Date>(value => typeof value === 'function').optional(), maxScanRecords: z.number().int().min(1).max(100000).optional() }).strict().parse(options);
    this.runtime = runtime; this.memory = runtime.memory; this.#now = parsed.now ?? (() => new Date()); this.#scanLimit = parsed.maxScanRecords ?? 10000;
    Object.defineProperties(this, { runtime: { writable: false, configurable: false }, memory: { writable: false, configurable: false } });
  }
  #time(): string {
    const now = this.#now(); if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Maintenance clock is invalid');
    this.#clockReversed = now.getTime() < this.#latestTime; this.#latestTime = Math.max(this.#latestTime, now.getTime());
    return now.toISOString();
  }
  #read(): void { if (!this.runtime.recallEnabled) throw new Error('Maintenance recall is disabled'); }
  #write(): void { this.#read(); if (!this.runtime.captureEnabled) throw new Error('Maintenance capture is disabled'); this.#time(); if (this.#clockReversed) throw new Error('Maintenance clock moved backwards'); }
  #inventory(): Inventory {
    const watches = new Map<string, Watch>(), checks = new Map<string, Check>();
    let cursor: string | undefined, scanned = 0;
    do {
      const page = this.memory.list({ limit: Math.min(1000, this.#scanLimit), cursor, includeUntrusted: true, metadata: { mnemosyneMaintenance: 'v1' } });
      scanned += page.items.length;
      if (scanned > this.#scanLimit || (scanned === this.#scanLimit && page.nextCursor)) throw new Error('Maintenance inventory exceeds scan budget');
      for (const record of page.items) {
        if (record.agentId !== this.memory.agentId) continue;
        if (record.visibility !== 'private' || record.kind !== 'observation' || record.metadata.advisory !== false) throw new Error('Invalid maintenance control');
        if (record.metadata.runtimeType === 'maintenance-watch') {
          const data = watchMetadata.parse(record.metadata);
          if (record.text !== 'Source freshness policy' || canonical(record.source) !== canonical({ uri: 'maintenance:watch' }) || record.supersedes || record.evidence || record.key || record.validFrom || record.validUntil || record.trust === 'verified'
            || record.dependencies.length !== 1 || record.dependencies[0] !== data.memoryId || watches.has(data.memoryId)) throw new Error('Invalid or conflicting maintenance watch');
          watches.set(data.memoryId, { record, data });
        } else if (record.metadata.runtimeType === 'maintenance-check') {
          const data = checkMetadata.parse(record.metadata);
          if (record.text !== 'Source freshness check' || canonical(record.source) !== canonical({ uri: 'maintenance:check' }) || record.trust !== 'observed' || record.evidence || record.key || record.validUntil
            || (!!record.supersedes !== !!data.correctionReason) || (record.validFrom !== undefined && !record.supersedes)
            || record.dependencies.length !== 2 || !record.dependencies.includes(data.memoryId) || !record.dependencies.includes(data.watchId) || checks.has(data.watchId)) throw new Error('Invalid or conflicting maintenance check');
          checks.set(data.watchId, { record, data });
        } else throw new Error('Unknown maintenance control');
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { watches, checks };
  }
  #assess(memoryId: string, inventory: Inventory, now: string, transitiveEligibilityChecked = false): FreshnessAssessment {
    const record = this.memory.get(memoryId), fingerprint = this.memory.getRecordFingerprint(memoryId) ?? undefined;
    const watch = inventory.watches.get(memoryId), check = watch ? inventory.checks.get(watch.record.id) : undefined;
    if (check && check.data.memoryId !== memoryId) throw new Error('Maintenance check target mismatch');
    const watchOutcomes = watch ? this.memory.getOutcomeSummary(watch.record.id) : undefined;
    const checkOutcomes = check ? this.memory.getOutcomeSummary(check.record.id) : undefined;
    const stateHash = hash({ memoryId, fingerprint, watch: watch && this.memory.getRecordFingerprint(watch.record.id), check: check && this.memory.getRecordFingerprint(check.record.id), watchOutcomes, checkOutcomes });
    const result: FreshnessAssessment = { memoryId, stateHash, fingerprint, status: 'unwatched', priority: watch?.data.priority ?? 0,
      ...(watch ? { watchId: watch.record.id } : {}), ...(check ? { lastCheckedAt: check.data.checkedAt } : {}), ...(check?.data.lastConfirmedAt ? { lastConfirmedAt: check.data.lastConfirmedAt } : {}) };
    if (!record) return { ...result, status: 'missing' };
    if (this.#clockReversed) return { ...result, status: 'clock-skew' };
    if (!transitiveEligibilityChecked && !this.memory.isEligible(memoryId)) return { ...result, status: 'ineligible' };
    if (!watch) return result;
    if (watchOutcomes?.failures) return { ...result, status: 'ineligible' };
    if (!check) return { ...result, status: 'needs-check' };
    if (checkOutcomes?.failures) return { ...result, status: 'needs-check' };
    if (check.data.checkedAt > now || (check.data.lastConfirmedAt && check.data.lastConfirmedAt > now)) return { ...result, status: 'clock-skew' };
    if (check.data.targetFingerprint !== fingerprint) return { ...result, status: 'needs-check' };
    if (check.data.status === 'changed') return { ...result, status: 'source-changed' };
    if (check.data.status === 'unavailable') return { ...result, status: 'unavailable' };
    if (!check.data.lastConfirmedAt) return { ...result, status: 'needs-check' };
    const due = new Date(Date.parse(check.data.lastConfirmedAt) + watch.data.maxAgeMs).toISOString();
    return { ...result, nextCheckAt: due, status: now >= due ? 'stale' : 'fresh' };
  }
  assess(memoryId: string): FreshnessAssessment {
    this.#read(); id.parse(memoryId);
    return this.memory.atomic(() => this.#assess(memoryId, this.#inventory(), this.#time()));
  }
  watchMemory(input: { memoryId: string; maxAgeMs: number; priority?: number }): FreshnessAssessment {
    const parsed = watchSchema.parse(input); this.#write();
    return this.memory.atomic(() => {
      this.#write(); const target = this.memory.get(parsed.memoryId);
      if (!target || target.status !== 'active' || target.metadata.advisory === false) throw new Error('Watched memory is unavailable or non-advisory');
      const inventory = this.#inventory(), existing = inventory.watches.get(parsed.memoryId);
      if (existing) {
        if (existing.data.maxAgeMs !== parsed.maxAgeMs || existing.data.priority !== parsed.priority) throw new Error('A watch already exists with another policy; use a new target revision');
        return this.#assess(parsed.memoryId, inventory, this.#time());
      }
      this.memory.store({ text: 'Source freshness policy', source: { uri: 'maintenance:watch' }, kind: 'observation', visibility: 'private', trust: target.trust === 'untrusted' ? 'untrusted' : 'observed', dependencies: [target.id], metadata: { mnemosyneMaintenance: 'v1', runtimeType: 'maintenance-watch', advisory: false, ...parsed } });
      return this.#assess(parsed.memoryId, this.#inventory(), this.#time());
    });
  }
  /** A confirmation records controller-supplied evidence; it never promotes trust. */
  recordCheck(input: { memoryId: string; expectedStateHash: string; observation: SourceCheckObservation }): FreshnessAssessment {
    const parsed = z.object({ memoryId: id, expectedStateHash: digest, observation: observationSchema }).strict().parse(input); this.#write();
    return this.memory.atomic(() => {
      this.#write(); const now = this.#time(), inventory = this.#inventory(), current = this.#assess(parsed.memoryId, inventory, now);
      const target = this.memory.get(parsed.memoryId), watch = inventory.watches.get(parsed.memoryId);
      if (!target || !watch || !current.fingerprint || current.stateHash !== parsed.expectedStateHash || ['missing', 'ineligible', 'clock-skew'].includes(current.status)) throw new Error('Source check is stale or target is ineligible');
      const previous = inventory.checks.get(watch.record.id);
      const lastConfirmedAt = parsed.observation.status === 'confirmed' ? now : previous?.data.lastConfirmedAt;
      const metadata = { mnemosyneMaintenance: 'v1', runtimeType: 'maintenance-check', advisory: false, memoryId: target.id, watchId: watch.record.id, checkedAt: now, ...(lastConfirmedAt ? { lastConfirmedAt } : {}), targetFingerprint: current.fingerprint, ...parsed.observation };
      if (previous) this.memory.correct(previous.record.id, { text: 'Source freshness check', source: { uri: 'maintenance:check' }, reason: 'New controller-supplied source evidence', metadata });
      else this.memory.store({ text: 'Source freshness check', source: { uri: 'maintenance:check' }, kind: 'observation', visibility: 'private', trust: target.trust === 'untrusted' ? 'untrusted' : 'observed', dependencies: [target.id, watch.record.id], metadata });
      return this.#assess(parsed.memoryId, this.#inventory(), now);
    });
  }
  scan(): { checkedAt: string; items: FreshnessAssessment[]; modelCalls: 0 } {
    this.#read();
    return this.memory.atomic(() => { const now = this.#time(), inventory = this.#inventory(); return { checkedAt: now, items: [...inventory.watches.keys()].map(key => this.#assess(key, inventory, now)).sort((a, b) => b.priority - a.priority || (a.nextCheckAt ?? '').localeCompare(b.nextCheckAt ?? '') || a.memoryId.localeCompare(b.memoryId)), modelCalls: 0 as const }; });
  }
  /** Explicit bounded work; hosts may schedule this. No timer starts at construction. */
  async probeDue(options: { probe: SourceCheckProbe; maxChecks?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<{ attempted: number; confirmed: number; changed: number; unavailable: number; failed: number; deferred: number }> {
    const started = performance.now(), probe = options.probe, signal = options.signal;
    const maxChecks = z.number().int().min(1).max(100).parse(options.maxChecks ?? 10), timeoutMs = z.number().int().min(1).max(60000).parse(options.timeoutMs ?? 10000);
    if (typeof probe !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))) throw new TypeError('An explicit source probe and valid signal are required');
    const deadline = started + timeoutMs;
    this.#write(); if (signal?.aborted) throw new Error('Maintenance cancelled');
    const due = this.scan().items.filter(item => ['needs-check', 'stale', 'source-changed', 'unavailable'].includes(item.status));
    const report = { attempted: 0, confirmed: 0, changed: 0, unavailable: 0, failed: 0, deferred: due.length };
    for (const freshness of due.slice(0, maxChecks)) {
      if (signal?.aborted || performance.now() >= deadline) break;
      const memory = this.memory.get(freshness.memoryId); if (!memory) continue;
      const targetId = memory.id, expectedStateHash = freshness.stateHash;
      this.#write(); report.attempted++; report.deferred--;
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
      try {
        const stop = new Promise<never>((_resolve, reject) => {
          const abort = () => { controller.abort(); reject(new Error('Maintenance deadline or cancellation')); };
          cancel = abort; signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
          if (signal?.aborted) abort();
        });
        const observation = observationSchema.parse(await Promise.race([Promise.resolve().then(() => {
          this.#write();
          if (controller.signal.aborted || signal?.aborted || performance.now() >= deadline) throw new Error('Maintenance deadline or cancellation');
          const current = this.assess(targetId), target = this.memory.get(targetId);
          if (!target || current.stateHash !== expectedStateHash || ['missing', 'ineligible', 'clock-skew'].includes(current.status)) throw new Error('Source changed before probe dispatch');
          return probe({ memory: target, freshness: current }, { signal: controller.signal });
        }), stop]));
        if (controller.signal.aborted || signal?.aborted || performance.now() >= deadline) throw new Error('Maintenance deadline or cancellation');
        this.recordCheck({ memoryId: targetId, expectedStateHash, observation }); report[observation.status]++;
      } catch { report.failed++; }
      finally { if (timer) clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel); }
    }
    return report;
  }
  #closure(roots: readonly string[], cache = new Map<string, MemoryRecord>()): MemoryRecord[] {
    const records = new Map<string, MemoryRecord>(), queue = [...roots];
    for (let position = 0; position < queue.length; position++) {
      const key = queue[position]; if (records.has(key)) continue;
      if (records.size >= 2048) throw new Error('Maintenance dependency budget exceeded');
      const cached = cache.get(key);
      if (!cached && cache.size >= 2048) throw new Error('Maintenance dependency budget exceeded');
      const record = cached ?? this.memory.get(key); if (!record) throw new Error('Memory dependency unavailable'); cache.set(key, record);
      records.set(key, record); queue.push(...record.dependencies);
    }
    return [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  #usable(state: FreshnessAssessment, requireWatched: boolean): boolean { return state.status === 'fresh' || (!requireWatched && state.status === 'unwatched'); }
  /** Only eligible items whose watched dependency chain is fresh are returned. */
  recall(input: { query: string; limit?: number; requireWatched?: boolean }) {
    const parsed = z.object({ query: text(4096), limit: z.number().int().min(1).max(100).default(20), requireWatched: z.boolean().default(false) }).strict().parse(input); this.#read();
    return this.memory.atomic(() => {
      const now = this.#time(), inventory = this.#inventory(), candidates = this.memory.recall({ query: parsed.query, limit: 100 });
      const items: typeof candidates = [], excluded: { memoryId: string; statuses: FreshnessStatus[] }[] = [];
      const cache = new Map<string, MemoryRecord>(), states = new Map<string, FreshnessAssessment>();
      for (const item of candidates) {
        const chain = this.#closure([item.memory.id], cache).map(record => { const value = states.get(record.id) ?? this.#assess(record.id, inventory, now, true); states.set(record.id, value); return value; });
        const failures = chain.filter(state => !this.#usable(state, parsed.requireWatched));
        if (failures.length) excluded.push({ memoryId: item.memory.id, statuses: [...new Set(failures.map(state => state.status))] });
        else if (items.length < parsed.limit) items.push(item);
      }
      return { checkedAt: now, items, excluded, candidateLimit: 100, modelCalls: 0 as const };
    });
  }
  /** Host asserts roots cover all memory dependencies of the intended action. */
  createReadSet(input: { memoryIds: string[]; actionKey: string; dependenciesComplete: true; lifetimeMs?: number; requireWatched?: boolean }): MemoryReadSet {
    const parsed = z.object({ memoryIds: z.array(id).min(1).max(64).refine(ids => new Set(ids).size === ids.length), actionKey: text(4096), dependenciesComplete: z.literal(true), lifetimeMs: z.number().int().min(1).max(60000).default(10000), requireWatched: z.boolean().default(false) }).strict().parse(input); this.#read();
    return this.memory.atomic(() => {
      const now = this.#time(), inventory = this.#inventory(); let expiry = Date.parse(now) + parsed.lifetimeMs;
      if (!parsed.memoryIds.every(id => this.memory.isEligible(id))) throw new Error('Action dependencies are stale, unverified or unavailable');
      const records = this.#closure(parsed.memoryIds).map(record => {
        const state = this.#assess(record.id, inventory, now, true);
        if (!this.#usable(state, parsed.requireWatched) || !state.fingerprint) throw new Error('Action dependencies are stale, unverified or unavailable');
        if (state.nextCheckAt) expiry = Math.min(expiry, Date.parse(state.nextCheckAt));
        return { id: record.id, fingerprint: state.fingerprint, stateHash: state.stateHash, outcomes: this.memory.getOutcomeSummary(record.id) };
      });
      const ticket = { version: 1 as const, workspaceId: this.memory.workspaceId, agentId: this.memory.agentId, actionHash: hash(parsed.actionKey), nonce: randomUUID(), createdAt: now, expiresAt: new Date(expiry).toISOString(), requireWatched: parsed.requireWatched, roots: [...parsed.memoryIds].sort(), records };
      return { ...ticket, signature: createHmac('sha256', this.#ticketKey).update(canonical(ticket)).digest('hex') };
    });
  }
  /** Point-in-time validation, not a lock on an external system or permission to act. */
  validateReadSet(input: unknown, actionKey: string): { valid: boolean; reason?: 'invalid-ticket' | 'expired' | 'dependencies-changed' | 'unavailable' } {
    this.#read(); text(4096).parse(actionKey);
    const parsed = ticketSchema.safeParse(input); if (!parsed.success) return { valid: false, reason: 'invalid-ticket' };
    const { signature, ...ticket } = parsed.data;
    const expected = createHmac('sha256', this.#ticketKey).update(canonical(ticket)).digest();
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected) || ticket.workspaceId !== this.memory.workspaceId || ticket.agentId !== this.memory.agentId || ticket.actionHash !== hash(actionKey)) return { valid: false, reason: 'invalid-ticket' };
    return this.memory.atomic(() => {
      const now = this.#time(); if (this.#clockReversed || now < ticket.createdAt || now >= ticket.expiresAt) return { valid: false, reason: 'expired' as const };
      try {
        const inventory = this.#inventory(), current = this.#closure(ticket.roots);
        if (!ticket.roots.every(id => this.memory.isEligible(id))) return { valid: false, reason: 'dependencies-changed' as const };
        if (current.length !== ticket.records.length) return { valid: false, reason: 'dependencies-changed' as const };
        for (let index = 0; index < current.length; index++) {
          const record = current[index], original = ticket.records[index], state = this.#assess(record.id, inventory, now, true);
          if (record.id !== original.id || !this.#usable(state, ticket.requireWatched) || state.fingerprint !== original.fingerprint || state.stateHash !== original.stateHash || canonical(this.memory.getOutcomeSummary(record.id)) !== canonical(original.outcomes)) return { valid: false, reason: 'dependencies-changed' as const };
        }
        return { valid: true };
      } catch { return { valid: false, reason: 'unavailable' as const }; }
    });
  }
}
