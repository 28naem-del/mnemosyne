import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { buildSeededStore, deterministicId, distinctiveTerms, falseAnswer, injectSeededFaults, locomoInstant } from '../src/evaluation/seeded-faults.js';

/**
 * The seeded-fault corpus: the store the bisect harness measures on.
 *
 * Everything here has to be a function of its inputs — same corpus and same
 * seed, same record ids, same poison text — or the harness numbers are not
 * reproducible by anyone else.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
afterEach(() => { opened.splice(0).forEach(memory => memory.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function store(): LocalMemory {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-seeded-'));
  roots.push(root);
  const memory = createLocalMemory({ path: join(root, 'memory.sqlite'), workspaceId: 'seeded', agentId: 'auditor', retrieval: 'lexical', ledger: false });
  opened.push(memory);
  return memory;
}

/** Two conversations' worth of the real LoCoMo shape, small enough to assert on. */
const SAMPLE = [{
  sample_id: 'conv-1',
  conversation: {
    speaker_a: 'Ada', speaker_b: 'Brix',
    session_1_date_time: '1:56 pm on 8 May, 2023',
    session_1: [
      { speaker: 'Ada', dia_id: 'D1:1', text: 'I adopted a greyhound called Pepper who sleeps on the velvet sofa.' },
      { speaker: 'Brix', dia_id: 'D1:2', text: 'That is wonderful news for the whole family. I will bring a squeaky toy tomorrow.' },
    ],
  },
  observation: { session_1_observation: { Ada: [['Ada adopted a greyhound named Pepper.', 'D1:1']], Brix: [] } },
  session_summary: { session_1_summary: 'Ada told Brix about adopting a greyhound.' },
  event_summary: { events_session_1: { Ada: ['Ada adopts a greyhound.'], Brix: [], date: '8 May, 2023' } },
  // 'sofa' occurs in this turn and nowhere else in the sample, so the turn is
  // the honest top hit before any fault is planted.
  qa: [{ question: 'Which sofa does Pepper use?', answer: 'the velvet sofa', evidence: ['D1:1'], category: 2 }],
}];

describe('deterministic identity and dates', () => {
  it('derives a UUID v4-shaped id that is a pure function of its parts', () => {
    const id = deterministicId('turn', 'conv-1/D1:1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicId('turn', 'conv-1/D1:1')).toBe(id);
    expect(deterministicId('turn', 'conv-1/D1:2')).not.toBe(id);
  });

  it('reads both LoCoMo date forms and refuses anything else', () => {
    expect(locomoInstant('1:56 pm on 8 May, 2023')).toBe('2023-05-08T13:56:00.000Z');
    expect(locomoInstant('8 May, 2023')).toBe('2023-05-08T12:00:00.000Z');
    expect(locomoInstant('12:30 am on 1 January, 2024')).toBe('2024-01-01T00:30:00.000Z');
    expect(locomoInstant('last summer')).toBeUndefined();
    expect(locomoInstant(undefined)).toBeUndefined();
  });
});

describe('poison construction', () => {
  it('produces a false value that is a competing claim, not noise', () => {
    expect(falseAnswer('7 May 2023', 'seed')).toBe('7 May 2020');
    expect(falseAnswer('3 dogs', 'seed')).toBe('10 dogs');
    const word = falseAnswer('Pepper', 'seed');
    expect(word).not.toBe('Pepper');
    expect(word.startsWith('Pepper-')).toBe(true);
    expect(falseAnswer('Pepper', 'seed')).toBe(word);
    expect(falseAnswer('Pepper', 'other-seed')).not.toBe(word);
  });

  it('keeps only the terms that make a query distinctive', () => {
    // 'what', 'did' and 'the' are stopwords; 'it' is too short to be worth a term.
    expect(distinctiveTerms('What did Ada name the greyhound?')).toEqual(['ada', 'name', 'greyhound']);
    expect(distinctiveTerms('who was it for')).toEqual([]);
  });
});

describe('the seeded store', () => {
  it('materialises the corpus at every granularity and maps the gold evidence', () => {
    const memory = store();
    const built = buildSeededStore(memory, SAMPLE, { workspaceId: 'seeded', agentId: 'auditor' });
    expect(built.composition).toMatchObject({ turns: 2, observations: 1, sessionSummaries: 1, eventSummaries: 1 });
    // Only the second turn is multi-sentence, and it yields both of its sentences.
    expect(built.composition.sentences).toBe(2);
    expect(built.composition.total).toBe(memory.list({ limit: 100 }).items.length);
    expect(built.newest).toBe('2023-05-08T13:56:00.000Z');

    expect(built.questions).toHaveLength(1);
    const question = built.questions[0];
    expect(question.id).toBe('conv-1:0');
    expect(question.gold).toEqual([deterministicId('turn', 'conv-1/D1:1')]);
    const gold = memory.get(question.gold[0]);
    expect(gold?.text).toBe('Ada: I adopted a greyhound called Pepper who sleeps on the velvet sofa.');
    expect(gold?.trust).toBe('observed');
    expect(gold?.validFrom).toBe('2023-05-08T13:56:00.000Z');
    // Real ingestion time, not the wall clock.
    expect(gold?.createdAt).toBe(built.ingestedAt);
  });

  it('builds the same store twice from the same corpus', () => {
    const first = buildSeededStore(store(), SAMPLE, { workspaceId: 'seeded', agentId: 'auditor' });
    const second = buildSeededStore(store(), SAMPLE, { workspaceId: 'seeded', agentId: 'auditor' });
    expect(second.questions.map(question => question.gold)).toEqual(first.questions.map(question => question.gold));
    expect(second.composition).toEqual(first.composition);
  });

  it('plants faults that displace the truth and are marked only for the harness', () => {
    const memory = store();
    const built = buildSeededStore(memory, SAMPLE, { workspaceId: 'seeded', agentId: 'auditor' });
    const question = built.questions[0];
    const before = memory.recall({ query: question.query, limit: 1 }).map(hit => hit.memory.id);
    expect(before).toEqual(question.gold);

    const faults = injectSeededFaults(memory, question, { count: 3, seed: 'v0-test', workspaceId: 'seeded', agentId: 'auditor', validFrom: built.newest });
    expect(faults).toHaveLength(3);
    expect(new Set(faults.map(fault => fault.id)).size).toBe(3);

    const after = memory.recall({ query: question.query, limit: 1 }).map(hit => hit.memory.id);
    expect(after).not.toEqual(question.gold);
    expect(faults.map(fault => fault.id)).toContain(after[0]);

    // The mark is metadata the harness scores with. Nothing in the kernel reads it,
    // and bisect is never handed the list.
    const planted = memory.get(faults[0].id);
    expect(planted?.metadata).toMatchObject({ granularity: 'seeded-fault', taskId: question.id, faultIndex: 0 });
    expect(planted?.trust).toBe('observed');
    expect(planted?.source.uri).toBe(`seeded://fault/${question.id}/0`);
  });
});
