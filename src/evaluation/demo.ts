import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../local/index.js';
import type { ContextPacket, MemoryRecord } from '../local/types.js';

export interface DemoStep {
  id: string;
  title: string;
  description: string;
  agent: string;
  memories: MemoryRecord[];
  context: ContextPacket;
  checks: { label: string; passed: boolean }[];
}

export interface DemoReport {
  mode: 'live' | 'recorded';
  title: string;
  description: string;
  generatedAt: string;
  steps: DemoStep[];
  checksPassed: number;
  checksTotal: number;
  limitations: string[];
}

/** A real, isolated kernel exercise. No LLM is called or simulated. */
export function runMemoryDemo(): DemoReport {
  const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-demo-'));
  const path = join(directory, 'experience.sqlite');
  const opened: LocalMemory[] = [];
  const open = (agentId: string) => {
    const memory = createLocalMemory({ path, workspaceId: 'catalogue-demo', agentId });
    opened.push(memory);
    return memory;
  };
  const steps: DemoStep[] = [];
  const query = 'catalogue images aspect ratio output approval';
  const snapshot = (memory: LocalMemory, step: Omit<DemoStep, 'memories' | 'context'>) => {
    steps.push({ ...step, memories: memory.inspect({ limit: 50, includeInactive: true }), context: memory.compile({ query, maxTokens: 4_096, taskId: 'catalogue-update' }) });
  };

  try {
    const maker = open('designer');
    const spec = maker.store({ text: 'Catalogue images require a 1200 x 900 output canvas. Preserve aspect ratio. Obtain owner approval before publishing.', kind: 'decision', key: 'catalogue-output', trust: 'observed', visibility: 'workspace', source: { uri: 'demo://owner/brief-v1' } });
    const privateNote = maker.store({ text: 'Private review code: BLUE-HERON-42. This must remain private.', trust: 'observed', source: { uri: 'demo://designer/private-note' } });
    snapshot(maker, { id: 'evidence', title: 'Start with evidence', description: 'The original brief has a source, an owner and an explicit sharing boundary.', agent: 'designer', checks: [{ label: 'Source and sharing policy persisted', passed: maker.get(spec.id)?.source.uri === 'demo://owner/brief-v1' && maker.get(privateNote.id)?.visibility === 'private' }] });

    const procedure = maker.store({ text: 'For catalogue images: fit the original aspect ratio inside a 1200 x 900 canvas; pad unused space instead of stretching. Request owner approval before publishing.', kind: 'procedure', trust: 'observed', visibility: 'workspace', dependencies: [spec.id], source: { uri: 'demo://designer/aspect-ratio-lesson' } });
    // A deterministic environment check supplies evidence. Agent self-report is
    // not substituted for a model evaluation or a real-world test result.
    const sourceWidth = 1_920;
    const sourceHeight = 1_080;
    const scale = Math.min(1_200 / sourceWidth, 900 / sourceHeight);
    const aspectPreserved = Math.abs((sourceWidth * scale) / (sourceHeight * scale) - sourceWidth / sourceHeight) < 1e-9;
    maker.recordOutcome({ memoryId: procedure.id, success: aspectPreserved, taskId: 'aspect-ratio-fixture-1', verifier: 'deterministic:aspect-ratio', evidence: `Source 1920x1080; fitted ${sourceWidth * scale}x${sourceHeight * scale}; ratio invariant=${aspectPreserved}` });
    maker.checkpoint({ taskId: 'catalogue-update', goal: 'Prepare catalogue images', completed: ['Tested aspect-preserving resize'], pending: ['Prepare final image set', 'Obtain owner approval'], decisions: ['Pad unused space; do not stretch'], constraints: ['Publication requires owner approval'], artifacts: ['demo://fixtures/ratio-check'], rejectedApproaches: ['Stretch every image to fill the canvas'], nextAction: 'Prepare the next image using the checked aspect-ratio procedure', visibility: 'workspace', dependencies: [procedure.id] });
    snapshot(maker, { id: 'learn', title: 'Keep the lesson and its result', description: 'A reusable procedure records the source it depends on and an outcome checked by the demo controller.', agent: 'designer', checks: [{ label: 'Aspect-ratio environment check passed', passed: aspectPreserved }, { label: 'Outcome linked to the procedure', passed: maker.recall({ query: 'catalogue images', limit: 20 }).some(r => r.memory.id === procedure.id && r.outcomes.successes === 1) }] });
    maker.close();
    opened.splice(opened.indexOf(maker), 1);

    const successor = open('publisher');
    const handoff = successor.resume('catalogue-update');
    const recalled = successor.recall({ query, limit: 20 });
    snapshot(successor, { id: 'handoff', title: 'A fresh agent picks up the work', description: 'The first connection is closed. A different agent reads the shared lesson and checkpoint from disk, while the private note stays hidden.', agent: 'publisher', checks: [{ label: 'Fresh agent can retrieve the shared procedure', passed: recalled.some(r => r.memory.id === procedure.id) }, { label: 'Checkpoint survives a closed connection', passed: handoff !== null }, { label: 'Private note is inaccessible by ID and search', passed: successor.get(privateNote.id) === null && successor.recall({ query: 'BLUE HERON', includeUntrusted: true }).length === 0 }] });

    const owner = open('designer');
    const revised = owner.correct(spec.id, { text: 'Catalogue images now require a 1600 x 1200 output canvas. Preserve aspect ratio. Owner approval is still required before publishing.', source: { uri: 'demo://owner/brief-v2' }, reason: 'The owner increased the output dimensions.' });
    snapshot(successor, { id: 'correct', title: 'Change the source. Retire the old advice.', description: 'The correction supersedes the brief and invalidates both the derived procedure and the handoff that depended on it. Historical records remain inspectable.', agent: 'publisher', checks: [{ label: 'Original brief superseded', passed: owner.get(spec.id)?.status === 'superseded' }, { label: 'Derived procedure and dependent handoff invalidated', passed: successor.get(procedure.id)?.status === 'invalidated' && successor.resume('catalogue-update') === null }, { label: 'Stale procedure excluded from active recall', passed: !successor.recall({ query, limit: 20 }).some(r => r.memory.id === procedure.id) }] });

    const replacement = successor.store({ text: 'For catalogue images: preserve the original aspect ratio inside a 1600 x 1200 canvas. Pad unused space. Keep the owner approval requirement before publishing.', kind: 'procedure', trust: 'observed', visibility: 'workspace', dependencies: [revised.id], source: { uri: 'demo://publisher/revised-procedure' } });
    const replacementScale = Math.min(1_600 / sourceWidth, 1_200 / sourceHeight);
    const outputFits = sourceWidth * replacementScale <= 1_600 && sourceHeight * replacementScale <= 1_200;
    successor.recordOutcome({ memoryId: replacement.id, taskId: 'aspect-ratio-fixture-2', success: outputFits, verifier: 'deterministic:canvas-bounds', evidence: `Fitted ${sourceWidth * replacementScale}x${sourceHeight * replacementScale} inside 1600x1200; fits=${outputFits}` });
    successor.checkpoint({ taskId: 'catalogue-update', goal: 'Prepare catalogue images', completed: ['Checked the revised canvas bounds'], pending: ['Prepare final image set', 'Obtain owner approval'], decisions: ['Use the updated brief and preserve aspect ratio'], constraints: ['Publication requires owner approval'], artifacts: ['demo://fixtures/revised-bounds-check'], rejectedApproaches: ['Reuse the superseded output dimensions'], nextAction: 'Prepare the next image using the corrected procedure', visibility: 'workspace', dependencies: [replacement.id] });
    const packet = successor.compile({ query, maxTokens: 4_096 });
    snapshot(successor, { id: 'recover', title: 'Continue with the corrected experience', description: 'The successor records a new procedure against the updated source. Its context shows citations and stays inside the declared budget.', agent: 'publisher', checks: [{ label: 'New procedure and updated handoff available', passed: packet.items.some(m => m.id === replacement.id) && successor.resume('catalogue-update')?.dependencies.includes(replacement.id) === true }, { label: 'Compiled context stays within its budget', passed: packet.tokens <= packet.tokenBudget }, { label: 'Old dimensions absent from current context', passed: !packet.text.includes('1200 x 900') }] });

    const forgotten = owner.forget(privateNote.id);
    snapshot(owner, { id: 'forget', title: 'Keep control of what remains', description: 'The private note is purged from this live store. Existing exports, backups and context already delivered to an agent remain outside this deletion boundary.', agent: 'designer', checks: [{ label: 'Forgotten record no longer readable', passed: forgotten.deletedIds.includes(privateNote.id) && owner.get(privateNote.id) === null }, { label: 'Purged text absent from owner export', passed: !JSON.stringify(owner.export()).includes('BLUE-HERON-42') }] });

    const checks = steps.flatMap(s => s.checks);
    const failures = checks.filter(c => !c.passed);
    if (failures.length) throw new Error(`Demo verification failed: ${failures.map(c => c.label).join('; ')}`);
    return { mode: 'live', title: 'One experience. A better starting point.', description: 'A reproducible memory-engine demonstration using two agent identities and a real temporary SQLite database. No language model or paid API is involved.', generatedAt: new Date().toISOString(), steps, checksPassed: checks.length, checksTotal: checks.length, limitations: ['This tests memory semantics, not autonomous agent competence or AGI.', 'Outcome evidence is supplied by the caller/controller; the library does not authenticate it.', 'This demonstration uses scoped lexical recall. Optional semantic retrieval and reranking are available through explicitly configured local model providers.', 'Deleted data may remain in external exports, backups, or previously delivered context.'] };
  } finally {
    for (const memory of opened) memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
