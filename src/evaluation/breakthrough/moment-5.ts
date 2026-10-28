/**
 * Moment 5 — "It got better on its own, and handed me the receipt."
 *
 * Consolidation ("dreaming") on the SYNTHETIC ops store the consolidation module
 * ships (`seedDemoStore`: eleven records and ten recorded tasks with a verifier
 * outcome). The deterministic, model-free proposer suggests merges; the gate
 * replays the agent's own recorded retrievals under the current state and under
 * the proposed one (on a scratch copy) and keeps a pass only when the outcomes do
 * not regress, no proposal regresses alone, the hold-out does not regress and
 * every invariant holds. Every verdict is an Ed25519-signed receipt chained by
 * digest in the ledger.
 *
 * What the user sees, in order: the first dream is rolled back because one of its
 * merges regressed alone; the same proposer's next dream (backoff drops the
 * faulted merge) is kept with its delta, replay-set size and hold-out; a
 * laundering dream (an untrusted forum instruction folded into a policy-tier
 * procedure) is rolled back by the invariants; the kept dream is undone in one
 * call, back to the identical `stateSha256`; and the receipt chain verifies.
 *
 * Proof (measured live): passes kept (delta >= 0 and hold-out >= 0), passes
 * rolled back, the rollback-restores-identical-hash flag, and the receipts
 * `verifyConsolidationChain` verified. The signing key is the module's fixed demo
 * key (reproducible receipts), never a key to sign a real store with.
 */
import { createLocalMemory, type LocalMemory } from '../../local/index.js';
import { replayState } from '../../local/replay.js';
import type { MemoryRecord } from '../../local/types.js';
import { gateConsolidation, proposeConsolidation, rollbackConsolidation, verifyConsolidationChain, type ConsolidationResult } from '../../consolidation/gate.js';
import { buildReplaySet } from '../../consolidation/replay-set.js';
import { createConsolidationSigner, receiptSignatureMessage, verifyConsolidationSignature } from '../../consolidation/signing.js';
import { DEMO_AGENT, DEMO_CLOCK_BASE, DEMO_SEED, DEMO_WORKSPACE, seedDemoStore } from '../../consolidation/demo.js';
import type { ConsolidationProposal } from '../../consolidation/types.js';
import type { MomentContext, MomentOutcome } from './types.js';

const short = (digest: string | null | undefined): string => (digest ? `${digest.slice(0, 16)}...` : 'null');
const stateNow = (memory: LocalMemory): string => replayState(memory, { knownAt: memory.export().exportedAt }).stateSha256;

/** What a careless summarizer would emit: the trusted on-call rule with the untrusted forum tip folded in, at `observed`. */
function launderingProposer(ids: Map<string, MemoryRecord>) {
  const oncall = ids.get('oncall')!, forum = ids.get('forum')!;
  return (): ConsolidationProposal[] => [{
    kind: 'merge', sources: [oncall.id, forum.id],
    outputs: [{ text: `${oncall.text} ${forum.text}`, kind: 'procedure', trust: 'observed', dependencies: [oncall.id] }],
    rationale: 'summarize database restart guidance',
  }];
}

export function momentConsolidation(context: MomentContext): MomentOutcome {
  const { say } = context;
  const signer = createConsolidationSigner({ seed: DEMO_SEED });
  let tick = DEMO_CLOCK_BASE;
  const memory = createLocalMemory({ path: ':memory:', workspaceId: DEMO_WORKSPACE, agentId: DEMO_AGENT, retrieval: 'lexical', ledger: { queries: 'text' }, now: () => new Date(tick += 1000) });
  try {
    const ids = seedDemoStore(memory);
    const replay = buildReplaySet(memory);
    say(`Seeded a synthetic ops store: ${ids.size} records, ${replay.tasks.length} recorded tasks with a verifier outcome (the replay set).`);
    say(`Receipts are signed with ed25519 keyId ${short(signer.keyId)} (the module's fixed demo key; never sign a real store with it).`);

    const passes: { label: string; result: ConsolidationResult }[] = [];
    const show = (label: string, result: ConsolidationResult): void => {
      passes.push({ label, result });
      const { receipt } = result;
      const s = receipt.scores;
      say('');
      say(`> dream ${passes.length}: ${label}`);
      if (s) say(`  replayed ${s.tasks} task(s) before ${s.before} after ${s.after} delta ${s.delta >= 0 ? '+' : ''}${s.delta}; hold-out ${s.holdout ? `${s.holdout.tasks} task(s) delta ${s.holdout.delta}` : 'none'}; per merge ${JSON.stringify(s.perProposal)}`);
      const broken = receipt.invariants.filter((invariant) => !invariant.ok).map((invariant) => invariant.name);
      say(`  invariants: ${broken.length ? `VIOLATED ${broken.join(', ')}` : receipt.invariants.length ? 'all hold' : 'not reached'}`);
      say(`  verdict ${receipt.verdict.toUpperCase()}: ${receipt.reason}`);
      say(`  receipt digest ${short(receipt.digest)} keyId ${short(receipt.receiptSignature.keyId)} prevDigest ${short(receipt.prevDigest)} signature ${verifyConsolidationSignature(receiptSignatureMessage(receipt.digest), receipt.receiptSignature) ? 'verifies' : 'DOES NOT VERIFY'}`);
    };

    const first = proposeConsolidation(memory, { signer });
    if (!first) throw new Error('the proposer found nothing to consolidate in the seeded store');
    show('two near-duplicate merges (deterministic proposer)', gateConsolidation(memory, first, { signer }));
    const second = proposeConsolidation(memory, { signer });
    if (!second) throw new Error('the proposer found nothing to consolidate after backoff');
    show('same proposer, backoff drops the merge that regressed', gateConsolidation(memory, second, { signer }));
    const stateAfterApply = stateNow(memory);
    const laundering = proposeConsolidation(memory, { signer, proposer: launderingProposer(ids), proposerName: 'demo-laundering (synthetic adversary)', backoff: false });
    if (!laundering) throw new Error('the laundering proposer produced no diff');
    show('laundering attempt: an untrusted forum tip folded into a policy-tier procedure', gateConsolidation(memory, laundering, { signer }));

    const kept = passes.filter((pass) => pass.result.verdict === 'kept');
    const rolledBack = passes.filter((pass) => pass.result.verdict === 'rolled_back');
    const keptHelped = kept.length > 0 && kept.every(({ result }) => (result.receipt.scores?.delta ?? -1) >= 0 && (result.receipt.scores?.holdout?.delta ?? 0) >= 0);
    say('');
    let restored = false;
    if (kept.length) {
      const target = kept[0].result.receipt;
      say(`> rollbackConsolidation(memory, '${target.passId}')   undo the kept dream in one call`);
      const undone = rollbackConsolidation(memory, target.passId, { signer });
      restored = undone.restored && undone.stateAfter === undone.stateBefore && undone.stateBefore === target.stateBefore;
      say(`  stateSha256 before the dream:   ${undone.stateBefore}`);
      say(`  stateSha256 after it was kept:  ${stateAfterApply}`);
      say(`  stateSha256 after rollback:     ${undone.stateAfter}`);
      say(`  identical: ${restored}; ${undone.deletedIds.length} created record(s) removed; rollback receipt ${short(undone.receipt.digest)}`);
    } else {
      say('  no dream was kept, so there is nothing to roll back');
    }
    const chain = verifyConsolidationChain(memory, { pinnedKeyIds: [signer.keyId] });
    say(`> verifyConsolidationChain(memory): ${chain.ok ? 'ok' : `BROKEN (${chain.errors.map((error) => error.error).join('; ')})`}, ${chain.receipts} receipts, head ${short(chain.head)}`);

    const keptDelta = kept[0]?.result.receipt.scores?.delta ?? null;
    const reasons = rolledBack.map(({ result }) => (result.receipt.reason.split(':')[0] ?? result.receipt.reason).trim());
    const passed = keptHelped && rolledBack.length >= 1 && restored && chain.ok && chain.receipts === passes.length + (kept.length ? 1 : 0) && stateAfterApply !== kept[0]?.result.receipt.stateBefore;
    return {
      proof: {
        label: 'consolidation receipts',
        measured: `kept ${kept.length} (delta ${keptDelta === null ? 'n/a' : `${keptDelta >= 0 ? '+' : ''}${keptDelta}`}), rolled back ${rolledBack.length} (${reasons.join(', ')}), rollback identical hash ${restored}, chain verified ${chain.ok ? chain.receipts : 0} receipts`,
        threshold: 'kept >= 1 with delta >= 0 and hold-out >= 0, rolled back >= 1, rollback restores the identical stateSha256, chain verifies',
        passed,
      },
      details: {
        replayTasks: replay.tasks.length, kept: kept.length, rolledBack: rolledBack.length, keptDelta, restored,
        chain: { ok: chain.ok, receipts: chain.receipts, head: chain.head }, keyId: signer.keyId,
        passes: passes.map(({ label, result }) => ({ label, verdict: result.verdict, reason: result.receipt.reason, digest: result.receipt.digest, prevDigest: result.receipt.prevDigest, delta: result.receipt.scores?.delta ?? null, holdoutDelta: result.receipt.scores?.holdout?.delta ?? null })),
      },
    };
  } finally {
    memory.close();
  }
}
