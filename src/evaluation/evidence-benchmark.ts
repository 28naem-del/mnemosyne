import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalMemory, type LocalMemory, type MemoryRecord, type RecallInput } from '../local/index.js';
import { MemoryRuntime } from '../runtime/index.js';

/** Synthetic controller-authored oracle. These are behavioral probes, not answer-quality scores. */
export interface EvidenceProbeResult {
  scenario: string;
  condition: 'raw-retrieval' | 'compiled-context';
  status: 'pass' | 'fail' | 'error';
  expectedValid: number;
  expectedEligible: number;
  retainedValid: number;
  wronglyRetired: number;
  exposedObsolete: number;
  returned: number;
  citationIds: number;
  validCitationIds: number;
  conflictExpected: boolean;
  conflictSurfaced: boolean;
  integrityFailures: number;
  error?: string;
}
export interface EvidenceBenchmarkReport {
  protocol: 'synthetic-evidence-lifecycle-v1';
  fixtureSha256: string;
  harnessSha256: string;
  engineRevision: string | null;
  modelCalls: 0;
  probes: EvidenceProbeResult[];
  unsupported: { scenario: string; reason: string }[];
  summary: Record<EvidenceProbeResult['condition'], {
    probes: number; passed: number; failed: number; errors: number;
    expectedValid: number; retainedValid: number; wronglyRetired: number; exposedObsolete: number;
    retentionCoverage: number | null; falseRetirementRate: number | null;
    citationIdentityPrecision: number | null;
  }>;
  limitations: string[];
}
const instant = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const fixture = {
  original: 'Atlas timeout is 30 seconds. Contact: operations.',
  changed: 'Atlas timeout is 10 seconds. Contact: operations.',
  unrelated: 'Atlas timeout is 30 seconds. Contact: support.',
  procedure: 'Atlas timeout procedure: wait 30 seconds before retrying.',
  independent: 'Atlas timeout audit logging is enabled.',
  protocol: 'synthetic-evidence-lifecycle-v1',
};
type Oracle = { valid: string[]; obsolete?: string[]; conflict?: boolean; erased?: string[] };

/** Runs only owned synthetic data in isolated temporary databases. Never opens a caller's store. */
export function runEvidenceBenchmark(options: { engineRevision?: string } = {}): EvidenceBenchmarkReport {
  if (options.engineRevision !== undefined && !/^[a-f0-9]{40}$/.test(options.engineRevision)) throw new Error('engineRevision must be a full git SHA');
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-evidence-'));
  const opened: LocalMemory[] = [];
  const probes: EvidenceProbeResult[] = [];
  let day = 2, sequence = 0;
  const now = () => new Date(instant(day));
  const open = (path: string, agentId = 'owner', workspaceId = 'evaluation') => {
    const memory = createLocalMemory({ path, agentId, workspaceId, now }); opened.push(memory); return memory;
  };
  const fresh = () => { day = 2; return open(join(root, `${++sequence}.sqlite`)); };
  const store = (memory: LocalMemory, text: string, dependencies: string[] = [], extra: { key?: string; validUntil?: string } = {}) => memory.store({
    text, kind: dependencies.length ? 'procedure' : 'fact', trust: 'observed',
    source: { uri: `fixture:${sequence}` }, dependencies, validFrom: instant(1), ...extra,
  });
  const probe = (scenario: string, memory: LocalMemory, oracle: Oracle, time: Pick<RecallInput, 'asOf' | 'knownAt'> = {}) => {
    for (const condition of ['raw-retrieval', 'compiled-context'] as const) {
      const base: EvidenceProbeResult = { scenario, condition, status: 'error', expectedValid: oracle.valid.length, expectedEligible: oracle.conflict ? 0 : oracle.valid.length,
        retainedValid: 0, wronglyRetired: 0, exposedObsolete: 0, returned: 0, citationIds: 0, validCitationIds: 0,
        conflictExpected: oracle.conflict ?? false, conflictSurfaced: false, integrityFailures: 0 };
      try {
        let records: MemoryRecord[], citations: string[] = [], conflictSurfaced = false, integrityFailures = 0;
        const invalidCitations = new Set<string>();
        const request = { query: 'Atlas timeout', maxTokens: 32768, ...time };
        if (condition === 'compiled-context') {
          const packet = memory.compile(request);
          const rendered: { memories?: { id: string; text: string; source: MemoryRecord['source']; trust: string }[]; conflicts?: unknown[] } = packet.text ? JSON.parse(packet.text) : { memories: [], conflicts: [] };
          if (!Array.isArray(rendered.memories)) throw new Error('Rendered memory envelope is invalid');
          const itemIds = new Set(packet.items.map(item => item.id));
          integrityFailures += Number(rendered.memories.length !== packet.items.length || rendered.memories.some(item => !itemIds.has(item.id)));
          for (const item of rendered.memories) {
            const record = packet.items.find(record => record.id === item.id);
            if (!record || item.text !== record.text || JSON.stringify(item.source) !== JSON.stringify(record.source) || item.trust !== record.trust) integrityFailures++;
          }
          for (const forbidden of oracle.obsolete ?? []) if (packet.text.includes(forbidden) && !rendered.memories.some(item => item.id === forbidden)) integrityFailures++;
          records = rendered.memories.map(item => ({ ...packet.items.find(record => record.id === item.id), ...item }) as MemoryRecord);
          citations = packet.citations.map(item => item.id);
          integrityFailures += Number(citations.length !== records.length || new Set(citations).size !== citations.length);
          for (const record of records) if (!packet.citations.some(citation => citation.id === record.id && citation.uri === record.source.uri && citation.trust === record.trust)) integrityFailures++;
          for (const citation of packet.citations) if (!records.some(record => record.id === citation.id && record.source.uri === citation.uri && record.trust === citation.trust)) invalidCitations.add(citation.id);
          conflictSurfaced = Array.isArray(rendered.conflicts) && rendered.conflicts.length > 0;
        } else records = memory.recall({ query: request.query, limit: 100, ...time }).map(item => item.memory);
        const returned = new Set(records.map(item => item.id));
        const retired = oracle.conflict ? 0 : oracle.valid.filter(id => !memory.isEligible(id, time)).length;
        if (oracle.conflict && oracle.valid.some(id => memory.isEligible(id, time))) integrityFailures++;
        for (const id of oracle.erased ?? []) if (memory.get(id) || memory.getAt(id, time)) integrityFailures++;
        const validCitationIds = citations.filter(id => !invalidCitations.has(id) && returned.has(id) && !!memory.getAt(id, time) && !(oracle.obsolete ?? []).includes(id)).length;
        const retainedValid = oracle.valid.filter(id => returned.has(id)).length;
        const exposedObsolete = (oracle.obsolete ?? []).filter(id => returned.has(id)).length;
        probes.push({ ...base, retainedValid, exposedObsolete, wronglyRetired: retired, returned: records.length,
          citationIds: citations.length, validCitationIds, conflictSurfaced, integrityFailures,
          status: retainedValid === oracle.valid.length && retired === 0 && exposedObsolete === 0
            && (!oracle.conflict || conflictSurfaced) && validCitationIds === citations.length && integrityFailures === 0 ? 'pass' : 'fail' });
      } catch (cause) { probes.push({ ...base, error: cause instanceof Error ? cause.message : 'Probe failed' }); }
    }
  };
  try {
    let memory = fresh();
    let source = store(memory, fixture.original);
    let advice = store(memory, fixture.procedure, [source.id]);
    probe('before-correction', memory, { valid: [source.id, advice.id] });
    day = 10;
    let replacement = memory.correct(source.id, { text: fixture.changed, source: source.source, reason: 'Timeout changed', validFrom: instant(5) });
    probe('relevant-correction-current', memory, { valid: [replacement.id], obsolete: [source.id, advice.id] });
    probe('historical-guidance-before-change', memory, { valid: [source.id, advice.id], obsolete: [replacement.id] }, { asOf: instant(3), knownAt: instant(10) });
    probe('delayed-knowledge-before-learning', memory, { valid: [source.id, advice.id], obsolete: [replacement.id] }, { asOf: instant(6), knownAt: instant(7) });
    probe('delayed-knowledge-after-learning', memory, { valid: [replacement.id], obsolete: [source.id, advice.id] }, { asOf: instant(6), knownAt: instant(10) });

    memory = fresh(); source = store(memory, fixture.original); advice = store(memory, fixture.procedure, [source.id]); day = 10;
    replacement = memory.correct(source.id, { text: fixture.unrelated, source: source.source, reason: 'Contact-only change', validFrom: instant(5) });
    // The external oracle knows the timeout is unchanged. The engine receives no such label.
    probe('unrelated-field-edit-retention', memory, { valid: [replacement.id, advice.id], obsolete: [source.id] });

    memory = fresh(); source = store(memory, fixture.original); advice = store(memory, fixture.procedure, [source.id]);
    const independent = store(memory, fixture.independent); day = 10;
    memory.correct(independent.id, { text: 'Atlas timeout audit logging is disabled.', source: independent.source, reason: 'Audit policy changed' });
    probe('independent-branch-retention', memory, { valid: [source.id, advice.id], obsolete: [independent.id] });

    memory = fresh();
    const runtime = new MemoryRuntime(memory, { now });
    const ingest = { uri: 'fixture:document', mimeType: 'text/plain', text: fixture.original, trust: 'observed' as const };
    source = runtime.ingestText(ingest).records[0]; advice = store(memory, fixture.procedure, [source.id]); day = 10;
    runtime.ingestText(ingest);
    probe('identical-source-reingestion', memory, { valid: [source.id, advice.id] });

    memory = fresh(); source = store(memory, 'Atlas timeout appointment is scheduled.', [], { validUntil: instant(5) }); day = 5;
    probe('expiration-half-open-boundary', memory, { valid: [], obsolete: [source.id] });
    probe('expired-event-historical', memory, { valid: [source.id] }, { asOf: instant(3) });

    memory = fresh(); source = store(memory, fixture.original, [], { key: 'atlas-timeout' });
    const conflicting = store(memory, fixture.changed, [], { key: 'atlas-timeout' });
    probe('unresolved-conflict-visible', memory, { valid: [source.id, conflicting.id], conflict: true });

    memory = fresh(); source = store(memory, fixture.original); advice = store(memory, fixture.procedure, [source.id]); day = 10;
    memory.recordOutcome({ memoryId: advice.id, taskId: 'failed-trial', success: false, verifier: 'fixture-controller', evidence: 'Retry caused duplicate operation.' });
    probe('failed-procedure-withheld', memory, { valid: [source.id], obsolete: [advice.id] });

    memory = fresh(); source = store(memory, fixture.original); advice = store(memory, fixture.procedure, [source.id]); day = 10;
    memory.forget(source.id);
    probe('erasure-current', memory, { valid: [], obsolete: [source.id, advice.id], erased: [source.id, advice.id] });
    probe('erasure-historical', memory, { valid: [], obsolete: [source.id, advice.id], erased: [source.id, advice.id] }, { asOf: instant(3), knownAt: instant(3) });

    const sharedPath = join(root, 'isolation.sqlite'); memory = open(sharedPath);
    const privatePeer = open(sharedPath, 'other-agent'), otherWorkspace = open(sharedPath, 'owner', 'other-workspace');
    const own = store(memory, fixture.original), peer = store(privatePeer, fixture.changed), foreign = store(otherWorkspace, fixture.changed);
    probe('scope-isolation', memory, { valid: [own.id], obsolete: [peer.id, foreign.id] });
    probe('scope-isolation-historical', memory, { valid: [own.id], obsolete: [peer.id, foreign.id] }, { asOf: instant(3), knownAt: instant(10) });
  } finally { opened.reverse().forEach(memory => memory.close()); rmSync(root, { recursive: true, force: true }); }
  const summary = Object.fromEntries((['raw-retrieval', 'compiled-context'] as const).map(condition => {
    const rows = probes.filter(item => item.condition === condition);
    const sum = (key: 'expectedValid' | 'expectedEligible' | 'retainedValid' | 'wronglyRetired' | 'exposedObsolete' | 'citationIds' | 'validCitationIds') => rows.reduce((total, item) => total + item[key], 0);
    const hasErrors = rows.some(row => row.status === 'error');
    return [condition, { probes: rows.length, passed: rows.filter(row => row.status === 'pass').length,
      failed: rows.filter(row => row.status === 'fail').length, errors: rows.filter(row => row.status === 'error').length,
      expectedValid: sum('expectedValid'), retainedValid: sum('retainedValid'), wronglyRetired: sum('wronglyRetired'), exposedObsolete: sum('exposedObsolete'),
      retentionCoverage: sum('expectedValid') ? sum('retainedValid') / sum('expectedValid') : null,
      falseRetirementRate: !hasErrors && sum('expectedEligible') ? sum('wronglyRetired') / sum('expectedEligible') : null,
      citationIdentityPrecision: !hasErrors && sum('citationIds') ? sum('validCitationIds') / sum('citationIds') : null }];
  })) as EvidenceBenchmarkReport['summary'];
  return { protocol: 'synthetic-evidence-lifecycle-v1', fixtureSha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
    harnessSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), engineRevision: options.engineRevision ?? null, modelCalls: 0, probes, summary,
    unsupported: [{ scenario: 'alternative-independent-support', reason: 'Dependencies represent conjunction, not alternative sufficient evidence. OR-support is not claimed.' }],
    limitations: ['Owned synthetic diagnostic fixtures, not a representative or held-out benchmark.',
      'Raw retrieval is a record inventory control with identical events; it is not an action-safe baseline or competitor implementation.',
      'No generated answers or actions. Obsolete exposure means IDs in the returned context, not measured model behavior.',
      'Citation identity validity does not establish textual entailment. Erasure and privacy violations share the forbidden-ID exposure counter.',
      'False retirement is evaluated against a controller-authored external oracle. Unresolved conflicts are retained information, not actionable guidance; they are excluded from the eligibility denominator. Errors make retirement and citation rates unavailable; retention conservatively counts missing results as failures.',
      'fixtureSha256 hashes the source texts; harnessSha256 hashes the complete executed evaluator including event sequence and oracles. engineRevision is caller supplied; run the identical evaluator file beside each frozen engine.',
      'Age-based freshness and live external-source checks are separate from these factual-validity probes.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const output = process.argv[2];
    if (process.argv.length > 3) throw new Error('Usage: node evidence-benchmark.js [new-report.json]');
    const report = runEvidenceBenchmark({ engineRevision: process.env.MNEMOSYNE_EVAL_ENGINE_REVISION });
    if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(output ? report.summary : report, null, 2));
  } catch (cause) { console.error(cause instanceof Error ? cause.message : 'Evidence benchmark failed'); process.exitCode = 1; }
}
