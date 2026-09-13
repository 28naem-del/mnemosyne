import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../local/index.js';
import { MemoryRuntime } from '../runtime/index.js';

export interface LearningDemoStep {
  id: string;
  title: string;
  passed: boolean;
  status: 'passed' | 'failed' | 'not-run';
  detail: string;
}

export interface LearningDemoReport {
  kind: 'deterministic integration demonstration';
  passed: boolean;
  checksPassed: number;
  checksTotal: number;
  steps: LearningDemoStep[];
  modelCalls: number;
  externalModelCalls: number;
  scriptedProposerCalls: number;
  trialCasesPassed: number;
  storage: string;
  limitations: string[];
}

const definitions = [
  ['empty', 'A new agent starts without the fixture lesson'],
  ['capture', 'Capture exact source text with a stable replay identity'],
  ['observe', 'Process one durable source-cited observation job'],
  ['candidate', 'Keep an untested skill out of compiled context'],
  ['trial', 'Promote the skill after an external controller trial'],
  ['share', 'Explicitly publish a source-backed workspace lesson'],
  ['peer', 'A second agent recalls the shared lesson'],
  ['isolation', 'Another workspace cannot read that lesson'],
  ['retire', 'A source correction suppresses the old skill'],
  ['peer-retire', 'The second agent stops recalling the stale lesson'],
  ['inspect', 'Original evidence remains available for inspection'],
  ['forget', 'Forgetting purges original and derived content'],
  ['restart', 'A tombstone blocks replay after reopening the database'],
] as const;

/**
 * Executes actual memory APIs over new, isolated SQLite files. The proposer and
 * trial cases below are hand-authored fixtures, not an LLM, model training,
 * autonomous discovery, a competitor comparison, or a performance benchmark.
 * Importing this module does not run the demonstration or open a database.
 */
export async function runLearningDemo(): Promise<LearningDemoReport> {
  const steps: LearningDemoStep[] = definitions.map(([id, title]) => ({ id, title, passed: false, status: 'not-run', detail: 'Not run.' }));
  const directory = mkdtempSync(join(tmpdir(), `mnemosyne-learning-demo-${process.pid}-`));
  const path = join(directory, 'memory.sqlite');
  const connections: LocalMemory[] = [];
  let current = steps[0];
  let scriptedProposerCalls = 0;
  let trialCasesPassed = 0;
  const open = (agentId: string, workspaceId = 'learning-fixture') => {
    const db = createLocalMemory({ path, agentId, workspaceId }); connections.push(db); return db;
  };
  const begin = (id: string) => { current = steps.find(step => step.id === id)!; };
  const check = (condition: boolean, detail: string) => {
    current.detail = detail;
    if (!condition) throw new Error(`Check failed: ${current.title}. ${detail}`);
    current.passed = true; current.status = 'passed';
  };
  try {
    const owner = open('fixture-author');
    const peer = open('fixture-reader');
    const outsider = open('fixture-reader', 'different-workspace');
    const runtime = new MemoryRuntime(owner);
    const query = 'Atlas export labels';
    check(peer.compile({ query, maxTokens: 4096 }).items.length === 0, 'An empty scoped database supplies no fixture evidence.');

    begin('capture');
    const originalText = 'For Atlas export files, trim whitespace from labels, then replace internal whitespace runs with one underscore.';
    const captureInput = { sessionId: 'atlas-export-fixture', adapter: 'generic' as const, trust: 'observed' as const, visibility: 'workspace' as const,
      messages: [{ id: 'source-message-1', role: 'user' as const, text: originalText }] };
    const captured = runtime.capture(captureInput).records[0];
    const replay = runtime.capture(captureInput).records[0];
    check(captured.text === originalText && captured.trust === 'observed' && captured.id === replay.id, 'The exact supplied message is observed evidence, and replay returns the same source ID.');

    begin('observe');
    const job = runtime.enqueue({ kind: 'observe', sourceIds: [captured.id] });
    if (job.state !== 'queued') throw new Error('The observation job was not durably queued.');
    const report = await runtime.runJobs({ maxJobs: 1, maxCalls: 1, timeoutMs: 1000, proposer: async request => {
      scriptedProposerCalls++;
      if (request.signal.aborted || request.sources.length !== 1 || request.sources[0].id !== captured.id || request.sources[0].text !== originalText) throw new Error('Unexpected fixture proposal envelope.');
      return { observations: [{ text: 'Atlas export labels use trimmed text and underscore-separated words; the provided message is the current procedure source.', sourceIds: [request.sources[0].id] }] };
    } });
    const completed = runtime.jobs().find(item => item.jobId === job.jobId);
    const observation = completed?.resultIds[0] ? owner.get(completed.resultIds[0]) : null;
    check(report.completed.includes(job.jobId) && scriptedProposerCalls === 1 && observation !== null && observation.dependencies.includes(captured.id) && observation.trust === 'observed', 'One scripted proposer call committed a distinct observation citing the supplied source ID.');
    if (!observation) throw new Error('Observation prerequisite is missing.');

    begin('candidate');
    const operations = ['Trim surrounding whitespace.', 'Replace internal whitespace runs with one underscore.'];
    const candidate = runtime.createSkill({ name: 'Atlas export labels', prerequisites: ['Input is a plain text label.'], steps: operations,
      parameters: { label: { description: 'Plain text export label.', required: true } }, evidenceIds: [observation.id] });
    check(candidate.state === 'candidate' && !owner.compile({ query, maxTokens: 8192 }).items.some(item => item.id === candidate.recordId), 'The candidate is untrusted control state and is absent from compiled context.');

    begin('trial');
    // The controller runs a small, explicit interpreter for these two fixture
    // operations. Skill text is never evaluated as code or shell commands.
    const allowedOperations: Record<string, (value: string) => string> = {
      [operations[0]]: value => value.trim(),
      [operations[1]]: value => value.replace(/\s+/g, '_'),
    };
    const cases = [{ input: '  Spring Campaign  ', expected: 'Spring_Campaign' }, { input: ' Atlas  Export ', expected: 'Atlas_Export' }];
    const promoted = await runtime.trialSkill({ id: candidate.id, timeoutMs: 1000, verifier: async ({ skill, signal }) => {
      if (signal.aborted) throw new Error('Fixture trial cancelled.');
      const prerequisitesSatisfied = skill.definition.prerequisites.includes('Input is a plain text label.') && cases.every(item => typeof item.input === 'string');
      const results = cases.map(item => {
        const actual = skill.definition.steps.reduce((value, operation) => {
          const apply = Object.hasOwn(allowedOperations, operation) ? allowedOperations[operation] : undefined;
          if (!apply) throw new Error('The fixture cannot execute an unknown operation.');
          return apply(value);
        }, item.input);
        return { ...item, actual, passed: actual === item.expected };
      });
      trialCasesPassed = results.filter(item => item.passed).length;
      return { passed: trialCasesPassed === cases.length, prerequisitesSatisfied, taskId: 'atlas-label-trial-1', verifier: 'deterministic-fixture-controller', evidence: JSON.stringify({ fixture: 'label-normalization-v1', results }) };
    } });
    check(promoted.state === 'active' && trialCasesPassed === 2 && owner.getOutcomeSummary(promoted.recordId).successes === 1 && owner.compile({ query, maxTokens: 8192 }).items.some(item => item.id === promoted.recordId), 'Two controller-executed cases passed; the observed skill has a recorded outcome and becomes eligible context.');

    begin('share');
    // Runtime skills and generated observations remain private. Publishing this
    // compact lesson is an explicit controller action with shared dependencies.
    const trialEvidence = owner.store({ kind: 'observation', text: promoted.trials[0].evidence, trust: 'observed', visibility: 'workspace',
      source: { uri: 'fixture:atlas-label-trial-1', author: 'deterministic-fixture-controller' }, dependencies: [captured.id] });
    const lesson = owner.store({ kind: 'procedure', text: `Atlas export labels: ${operations.join(' ')} Prerequisite: plain text label. Controller fixture: 2 cases passed.`, trust: 'observed', visibility: 'workspace',
      source: { uri: 'fixture:shared-atlas-label-lesson', author: 'fixture-author' }, dependencies: [captured.id, trialEvidence.id] });
    check(lesson.visibility === 'workspace' && lesson.dependencies.every(id => owner.get(id)?.visibility === 'workspace'), 'The explicit shared lesson depends on shared original evidence and trial results, with no private skill IDs.');

    begin('peer');
    const recalled = peer.compile({ query, maxTokens: 8192 });
    check(recalled.items.some(item => item.id === lesson.id) && recalled.citations.some(item => item.uri === lesson.source.uri) && peer.get(promoted.recordId) === null && peer.get(observation.id) === null, 'The second scoped LocalMemory recalls the lesson with citations while private runtime records remain inaccessible.');

    begin('isolation');
    check(outsider.compile({ query, maxTokens: 8192 }).items.length === 0 && outsider.get(lesson.id) === null, 'The same reader identity in a different workspace receives no fixture memories.');

    begin('retire');
    const corrected = owner.correct(captured.id, { text: 'For Atlas export files, preserve label whitespace exactly. The earlier underscore conversion procedure was retired.',
      source: { uri: 'fixture:corrected-atlas-label-policy' }, reason: 'The fixture controller supplied a new policy.' });
    check(runtime.getSkill(candidate.id)?.state === 'retired' && !owner.compile({ query, maxTokens: 8192 }).items.some(item => item.id === promoted.recordId), 'Correcting the transitive source immediately retires the old skill without waiting for another job.');

    begin('peer-retire');
    check(!peer.compile({ query, maxTokens: 8192 }).items.some(item => item.id === lesson.id), 'The shared lesson is invalidated through its source dependency and is no longer supplied to the second agent.');

    begin('inspect');
    const original = runtime.expandSource(captured.id, { maxBytes: 4096 });
    check(original.text === originalText && original.status === 'superseded' && original.source.uri.startsWith('transcript://'), 'Explicit source inspection retains the original message and provenance after correction.');

    begin('forget');
    const forgotten = runtime.forgetSource(corrected.id);
    check([captured.id, corrected.id, observation.id, promoted.recordId, lesson.id].every(id => forgotten.deletedIds.includes(id) && owner.get(id) === null) && peer.compile({ query, maxTokens: 8192 }).items.length === 0, 'Forgetting the captured source removes its correction history, learned procedures, shared lesson and derived evidence from the live store.');

    begin('restart');
    connections.splice(0).forEach(db => db.close());
    const reopened = open('fixture-author'); const restarted = new MemoryRuntime(reopened);
    let blocked = false;
    try { restarted.capture(captureInput); } catch (error) { blocked = error instanceof Error && error.message.includes('tombstone'); }
    const tombstones = reopened.list({ includeUntrusted: true, metadata: { runtimeType: 'tombstone' } }).items;
    check(blocked && tombstones.length === 1 && !reopened.isEligible(tombstones[0].id) && !JSON.stringify(tombstones).includes(originalText), 'The reopened database retains only a non-advisory tombstone for this source identity and rejects replay.');
  } catch (error) {
    current.passed = false; current.status = 'failed'; current.detail = error instanceof Error ? error.message.slice(0, 2048) : 'The demonstration failed.';
  } finally {
    try { connections.forEach(db => db.close()); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const checksPassed = steps.filter(step => step.passed).length;
  return { kind: 'deterministic integration demonstration', passed: checksPassed === steps.length, checksPassed, checksTotal: steps.length, steps,
    modelCalls: 0, externalModelCalls: 0, scriptedProposerCalls, trialCasesPassed, storage: 'New temporary SQLite database; connections closed and files removed after this run.',
    limitations: [
      'Hand-authored source, proposer and trial fixtures; no LLM was invoked or trained.',
      'Checks establish these integration behaviors, not general task improvement, AGI, or competitor superiority.',
      'Trial verification and workspace publication are explicit controller actions; callbacks are trusted assertions, not authentication.',
      'The two-agent check uses two scoped connections in one local process, not a distributed load test.',
      'Forgetting covers this live store and replay identity; it does not certify erasure of external backups or device snapshots.',
    ] };
}
