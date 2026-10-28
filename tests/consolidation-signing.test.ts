import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import {
  consolidate, consolidationReceipts, createConsolidationSigner, receiptDigest, rollbackConsolidation, verifyConsolidationChain,
  verifyConsolidationSignature, type ConsolidationReceipt,
} from '../src/consolidation/index.js';

/** Signatures, the key file, and the verdict digest chain over ledger receipts. Fixtures are synthetic. */

const roots: string[] = [];
const opened: LocalMemory[] = [];
afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const dir = (): string => { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-consolidation-')); roots.push(root); return root; };
const seeded = (byte: number) => createConsolidationSigner({ seed: new Uint8Array(32).fill(byte) });

function open(path: string): LocalMemory {
  let tick = Date.UTC(2026, 0, 1);
  const db = createLocalMemory({ path, workspaceId: 'w', agentId: 'agent', retrieval: 'lexical', ledger: { queries: 'text' }, now: () => new Date(tick += 1000) });
  opened.push(db);
  return db;
}

/** A kept merge, then its rollback: two chained receipts. */
function history(path: string, signer = seeded(1)): LocalMemory {
  const db = open(path);
  const a = db.store({ text: 'Deploys run from the release branch after the smoke suite passes.', kind: 'procedure', trust: 'observed', source: { uri: 'note://a' } });
  const b = db.store({ text: 'Deploys run from the release branch once the smoke suite passes.', kind: 'procedure', trust: 'observed', source: { uri: 'note://b' } });
  for (const [taskId, query] of [['t1', 'deploys after once smoke suite'], ['t2', 'release branch after once passes']]) {
    db.recall({ query, limit: 1 });
    db.recordRetrievalOutcome({ taskId, success: true, verifier: 'test-ci (synthetic)', evidence: taskId });
    for (const id of [a.id, b.id]) db.recordOutcome({ memoryId: id, taskId, success: true, verifier: 'test-ci (synthetic)', evidence: `${taskId}:${id}` });
  }
  const kept = consolidate(db, { signer })!;
  expect(kept.verdict).toBe('kept');
  rollbackConsolidation(db, kept.receipt.passId, { signer });
  return db;
}

function rewrite(path: string, sequenceIndex: number, edit: (receipt: ConsolidationReceipt) => ConsolidationReceipt | null): void {
  const raw = new DatabaseSync(path);
  try {
    const rows = raw.prepare("SELECT sequence,data FROM local_ledger WHERE event='consolidation' ORDER BY sequence").all() as { sequence: number; data: string }[];
    const row = rows[sequenceIndex];
    const payload = JSON.parse(row.data) as { consolidation: ConsolidationReceipt };
    const next = edit(payload.consolidation);
    if (next === null) raw.prepare('DELETE FROM local_ledger WHERE sequence=?').run(row.sequence);
    else raw.prepare('UPDATE local_ledger SET data=? WHERE sequence=?').run(JSON.stringify({ consolidation: next }), row.sequence);
  } finally { raw.close(); }
}

describe('consolidation signatures', () => {
  it('derives a stable key id and deterministic Ed25519 signatures from a seed', () => {
    const one = seeded(9), two = seeded(9), other = seeded(10);
    expect(one.keyId).toMatch(/^[a-f0-9]{64}$/);
    expect(two.keyId).toBe(one.keyId);
    expect(other.keyId).not.toBe(one.keyId);
    expect(two.sign('message')).toEqual(one.sign('message'));
    const signature = one.sign('message');
    expect(verifyConsolidationSignature('message', signature)).toBe(true);
    expect(verifyConsolidationSignature('message!', signature)).toBe(false);
    expect(verifyConsolidationSignature('message', { ...signature, keyId: other.keyId })).toBe(false);
    expect(verifyConsolidationSignature('message', { ...signature, publicKey: other.sign('x').publicKey })).toBe(false);
    expect(verifyConsolidationSignature('message', { ...signature, algorithm: 'hmac' })).toBe(false);
    for (const junk of [null, undefined, {}, 'sig', { ...signature, value: 'not base64url!' }]) expect(verifyConsolidationSignature('message', junk)).toBe(false);
  });

  it('creates the key file once with 0600 and refuses symlinks and directories', () => {
    const root = dir();
    const keyFile = join(root, 'memory.sqlite.consolidation.key');
    const first = createConsolidationSigner({ keyFile });
    expect(first.origin).toBe('file');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(createConsolidationSigner({ keyFile }).keyId).toBe(first.keyId);
    const link = join(root, 'link.key');
    symlinkSync(keyFile, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(() => createConsolidationSigner({ keyFile: link })).toThrow(/regular file/);
    mkdirSync(join(root, 'dir.key'));
    expect(() => createConsolidationSigner({ keyFile: join(root, 'dir.key') })).toThrow();
    expect(() => createConsolidationSigner({ keyFile, ephemeral: true } as never)).toThrow(/exactly one/);
    expect(() => createConsolidationSigner({ seed: new Uint8Array(31) })).toThrow(/32 bytes/);
  });
});

describe('verdict digest chain', () => {
  it('verifies an untouched chain and keeps record text out of receipts', () => {
    const path = join(dir(), 'memory.sqlite');
    const db = history(path);
    const report = verifyConsolidationChain(db);
    expect(report).toMatchObject({ ok: true, receipts: 2, keyChanges: [], errors: [] });
    const receipts = consolidationReceipts(db).map(({ receipt }) => receipt);
    expect(receipts[1].prevDigest).toBe(receipts[0].digest);
    expect(report.head).toBe(receipts[1].digest);
    expect(JSON.stringify(receipts)).not.toMatch(/smoke suite/);
    expect(verifyConsolidationChain(db, { pinnedKeyIds: [seeded(1).keyId] }).ok).toBe(true);
    expect(verifyConsolidationChain(db, { pinnedKeyIds: [seeded(2).keyId] }).errors.map((error) => error.error)).toContain('receipt is signed by a key that is not pinned');
  });

  it('detects an edited verdict, a re-digested edit without the key, and a deleted receipt', () => {
    const root = dir();
    const edited = join(root, 'edited.sqlite');
    history(edited).close();
    rewrite(edited, 0, (receipt) => ({ ...receipt, reason: 'looks fine' }));
    expect(verifyConsolidationChain(open(edited)).errors.map((error) => error.error)).toEqual(expect.arrayContaining(['digest does not match the receipt']));

    const resealed = join(root, 'resealed.sqlite');
    history(resealed).close();
    rewrite(resealed, 0, (receipt) => { const next = { ...receipt, reason: 'looks fine' }; return { ...next, digest: receiptDigest(next) }; });
    const errors = verifyConsolidationChain(open(resealed)).errors.map((error) => error.error);
    expect(errors).toEqual(expect.arrayContaining(['receipt signature does not verify', 'prevDigest does not link to the previous receipt']));

    const deleted = join(root, 'deleted.sqlite');
    history(deleted).close();
    rewrite(deleted, 0, () => null);
    expect(verifyConsolidationChain(open(deleted)).errors.map((error) => error.error)).toEqual(expect.arrayContaining(['prevDigest does not link to the previous receipt', 'rollback names no earlier kept pass']));
  });

  it('reports a change of signing key without failing, unless keys are pinned', () => {
    const path = join(dir(), 'memory.sqlite');
    const db = history(path, seeded(1));
    const second = seeded(2);
    const a = db.store({ text: 'Backups are verified every Sunday at 03:00 UTC.', kind: 'fact', trust: 'observed', source: { uri: 'note://c' } });
    db.store({ text: 'Backups are verified every Sunday at 03:00 UTC sharp.', kind: 'fact', trust: 'observed', source: { uri: 'note://d' } });
    db.recall({ query: 'backups sunday', limit: 1 });
    db.recordRetrievalOutcome({ taskId: 't3', success: true, verifier: 'test-ci (synthetic)', evidence: 't3' });
    db.recordOutcome({ memoryId: a.id, taskId: 't3', success: true, verifier: 'test-ci (synthetic)', evidence: 't3:a' });
    consolidate(db, { signer: second });
    const report = verifyConsolidationChain(db);
    expect(report.ok).toBe(true);
    expect(report.keyChanges).toEqual([{ sequence: expect.any(Number), from: seeded(1).keyId, to: second.keyId }]);
    expect(verifyConsolidationChain(db, { pinnedKeyIds: [seeded(1).keyId] }).ok).toBe(false);
  });
});
