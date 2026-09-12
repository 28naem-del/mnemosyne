import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { z } from 'zod';
import { createLocalMemory, type LocalMemory, type MemoryEmbedder, type MemoryRecord, type RecallResult } from '../local/index.js';

export const LONGMEMEVAL_PROTOCOL_SOURCES = [
  'https://github.com/xiaowu0162/LongMemEval',
  'https://arxiv.org/html/2410.10813v2',
  'https://raw.githubusercontent.com/xiaowu0162/LongMemEval/main/src/evaluation/evaluate_qa.py',
] as const;
const questionTypes = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'temporal-reasoning', 'knowledge-update', 'multi-session'] as const;
export type LongMemEvalQuestionType = typeof questionTypes[number];
export type LongMemEvalBaseline = 'no-memory' | 'lexical' | 'hybrid';
export interface LongMemEvalOptions {
  topK?: number;
  /** Lexical candidate budget and most-recent vector candidate window. */
  maxCandidates?: number;
  maxQuestions?: number;
  maxSessionsPerQuestion?: number;
  maxMessagesPerQuestion?: number;
  maxBytesPerQuestion?: number;
  maxDatasetBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Existing parent directory for new temporary databases, never a live DB path. */
  tempParent?: string;
  datasetLabel?: string;
  datasetRevision?: string;
  /** Optional explicit adapter. Nothing selects or configures a provider automatically. */
  embedder?: MemoryEmbedder;
  maxEmbeddingCalls?: number;
  maxEmbeddingInputBytes?: number;
}
export interface LongMemEvalCase {
  questionId: string;
  questionType: LongMemEvalQuestionType;
  question: string;
  questionDate: string;
  questionTime: string;
  unanswerable: boolean;
  evidenceSessionIds: string[];
  sessions: { id: string; date: string; timestamp: string; turns: { role: 'user' | 'assistant'; content: string }[] }[];
}
export interface LongMemEvalRetrieval {
  sessionId: string;
  sessionDate: string;
  turnIndex: number;
  role: 'user' | 'assistant';
  score: number;
}
export interface LongMemEvalBaselineResult {
  retrievedTurns: LongMemEvalRetrieval[];
  retrievedSessionIds: string[];
  matchedSessionIds: string[];
  hasRetrievedContext: boolean;
  evidenceSessionRecall: number | null;
  evidenceSessionPrecision: number | null;
  allEvidenceRetrieved: boolean | null;
}
export interface LongMemEvalQuestionResult {
  questionId: string;
  questionType: LongMemEvalQuestionType;
  questionDate: string;
  answerability: 'answerable' | 'unanswerable';
  evidenceSessionIds: string[];
  historySessions: number;
  historyTurns: number;
  indexedTurns: number;
  indexedBytes: number;
  baselines: Partial<Record<LongMemEvalBaseline, LongMemEvalBaselineResult>>;
}
export interface LongMemEvalSummary {
  questions: number;
  withRetrievedContext: number;
  emptyContext: number;
  retrievedContextRate: number | null;
  evidenceAnnotatedQuestions: number;
  completeEvidenceQuestions: number;
  completeEvidenceRate: number | null;
  meanEvidenceSessionRecall: number | null;
  meanEvidenceSessionPrecision: number | null;
  microEvidenceSessionRecall: number | null;
  microEvidenceSessionPrecision: number | null;
}
export interface LongMemEvalReport {
  kind: 'LongMemEval-style offline retrieval evaluation';
  protocol: 'v1-turn-retrieval-session-evidence';
  dataset: { origin: 'caller-supplied; official provenance not verified'; label?: string; revision?: string; sha256: string; bytes: number; questions: number };
  granularity: 'turn';
  topK: number;
  providerMode: 'none' | 'caller-supplied-embedder';
  embeddingModel?: { model: string; dimensions: number };
  calls: { embedding: number; generation: 0; judge: 0; embeddingInputBytes: number };
  answerQuality: { status: 'not-evaluated'; abstentionAccuracy: null };
  results: LongMemEvalQuestionResult[];
  summary: Partial<Record<LongMemEvalBaseline, { all: LongMemEvalSummary; answerable: LongMemEvalSummary; unanswerable: LongMemEvalSummary; byQuestionType: Partial<Record<LongMemEvalQuestionType, LongMemEvalSummary>> }>>;
  limits: ReturnType<typeof limits>;
  storage: 'fresh scoped SQLite per question; temporary files removed';
  durationMs: number;
  limitations: string[];
  protocolSources: readonly string[];
}
const boundedText = (maximum: number, allowEmpty = false) => z.string().refine(value => (allowEmpty || !!value.trim()) && !value.includes('\0') && Buffer.byteLength(value) <= maximum, `Text exceeds ${maximum} bytes, is empty or contains NUL.`);
function integer(value: number | undefined, fallback: number, maximum: number, name: string) {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return parsed;
}
function limits(options: LongMemEvalOptions) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Evaluation options must be an object.');
  const allowed = ['topK', 'maxCandidates', 'maxQuestions', 'maxSessionsPerQuestion', 'maxMessagesPerQuestion', 'maxBytesPerQuestion', 'maxDatasetBytes', 'timeoutMs', 'signal', 'tempParent', 'datasetLabel', 'datasetRevision', 'embedder', 'maxEmbeddingCalls', 'maxEmbeddingInputBytes'];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Unknown evaluation option.');
  return {
    topK: integer(options.topK, 20, 100, 'topK'),
    maxCandidates: integer(options.maxCandidates, 1000, 10000, 'maxCandidates'),
    maxQuestions: integer(options.maxQuestions, 100, 500, 'maxQuestions'),
    maxSessionsPerQuestion: integer(options.maxSessionsPerQuestion, 1000, 2000, 'maxSessionsPerQuestion'),
    maxMessagesPerQuestion: integer(options.maxMessagesPerQuestion, 20000, 100000, 'maxMessagesPerQuestion'),
    maxBytesPerQuestion: integer(options.maxBytesPerQuestion, 16_777_216, 67_108_864, 'maxBytesPerQuestion'),
    maxDatasetBytes: integer(options.maxDatasetBytes, 67_108_864, 536_870_912, 'maxDatasetBytes'),
    timeoutMs: integer(options.timeoutMs, 60000, 1_800_000, 'timeoutMs'),
    maxEmbeddingCalls: integer(options.maxEmbeddingCalls, 20, 10000, 'maxEmbeddingCalls'),
    maxEmbeddingInputBytes: integer(options.maxEmbeddingInputBytes, 16_777_216, 536_870_912, 'maxEmbeddingInputBytes'),
  };
}
function timestamp(raw: string): string {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/.exec(raw);
  const iso = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z` : raw;
  if (!z.iso.datetime({ offset: true }).safeParse(iso).success) throw new Error('Unsupported or invalid benchmark timestamp; use YYYY/MM/DD (Day) HH:mm or ISO 8601.');
  return new Date(iso).toISOString();
}
function decode(input: unknown, budget: ReturnType<typeof limits>) {
  const serialized = typeof input === 'string' ? input : JSON.stringify(input);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > budget.maxDatasetBytes) throw new Error('Dataset exceeds maxDatasetBytes or is not JSON.');
  const raw: unknown = JSON.parse(serialized);
  if (!Array.isArray(raw) || !raw.length || raw.length > budget.maxQuestions) throw new Error('Dataset must be a nonempty question array within maxQuestions; select an explicit batch.');
  const schema = z.object({
    question_id: boundedText(512), question_type: z.enum(questionTypes), question: boundedText(4096), question_date: boundedText(128),
    haystack_session_ids: z.array(boundedText(512)).max(budget.maxSessionsPerQuestion),
    haystack_dates: z.array(boundedText(128)).max(budget.maxSessionsPerQuestion),
    haystack_sessions: z.array(z.array(z.object({ role: z.enum(['user', 'assistant']), content: boundedText(65536, true) })).max(budget.maxMessagesPerQuestion)).max(budget.maxSessionsPerQuestion),
    answer_session_ids: z.array(boundedText(512)).max(budget.maxSessionsPerQuestion),
    // answer, has_answer and extension annotations are deliberately stripped.
  });
  const seenQuestions = new Set<string>();
  const cases = raw.map(entry => {
    if (Buffer.byteLength(JSON.stringify(entry)) > budget.maxBytesPerQuestion) throw new Error('Question exceeds maxBytesPerQuestion.');
    const value = schema.parse(entry);
    if (seenQuestions.has(value.question_id)) throw new Error('Duplicate question_id.');
    seenQuestions.add(value.question_id);
    if (value.haystack_session_ids.length !== value.haystack_sessions.length || value.haystack_dates.length !== value.haystack_sessions.length) throw new Error('History session IDs, dates and contents must have equal lengths.');
    if (value.answer_session_ids.some(id => !value.haystack_session_ids.includes(id))) throw new Error('An evidence session ID is absent from this question history.');
    if (value.haystack_sessions.reduce((count, turns) => count + turns.length, 0) > budget.maxMessagesPerQuestion) throw new Error('Question exceeds maxMessagesPerQuestion.');
    const questionTime = timestamp(value.question_date);
    const sessions = value.haystack_sessions.map((turns, index) => ({ id: value.haystack_session_ids[index], date: value.haystack_dates[index], timestamp: timestamp(value.haystack_dates[index]), turns }));
    if (sessions.some(session => session.timestamp > questionTime)) throw new Error('History sessions must not occur after the question date.');
    sessions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { questionId: value.question_id, questionType: value.question_type, question: value.question, questionDate: value.question_date, questionTime, unanswerable: value.question_id.endsWith('_abs'), evidenceSessionIds: [...new Set(value.answer_session_ids)], sessions } satisfies LongMemEvalCase;
  });
  return { cases, bytes: Buffer.byteLength(serialized), sha256: createHash('sha256').update(serialized).digest('hex') };
}

/** Adapts the documented v1 JSON shape; drops reference answers and turn labels. */
export function parseLongMemEvalDataset(input: unknown, options: LongMemEvalOptions = {}): LongMemEvalCase[] {
  return decode(input, limits(options)).cases;
}
function score(retrievedTurns: LongMemEvalRetrieval[], evidenceSessionIds: string[]): LongMemEvalBaselineResult {
  const retrievedSessionIds = [...new Set(retrievedTurns.map(turn => turn.sessionId))];
  const matchedSessionIds = evidenceSessionIds.filter(id => retrievedSessionIds.includes(id));
  const labeled = evidenceSessionIds.length > 0;
  return { retrievedTurns, retrievedSessionIds, matchedSessionIds, hasRetrievedContext: retrievedTurns.length > 0,
    evidenceSessionRecall: labeled ? matchedSessionIds.length / evidenceSessionIds.length : null,
    evidenceSessionPrecision: labeled ? (retrievedSessionIds.length ? matchedSessionIds.length / retrievedSessionIds.length : 0) : null,
    allEvidenceRetrieved: labeled ? matchedSessionIds.length === evidenceSessionIds.length : null };
}
function summarize(rows: LongMemEvalQuestionResult[], baseline: LongMemEvalBaseline): LongMemEvalSummary {
  const entries = rows.map(row => ({ result: row.baselines[baseline]!, gold: row.evidenceSessionIds.length }));
  const labeled = entries.filter(entry => entry.gold > 0);
  const withContext = entries.filter(entry => entry.result.hasRetrievedContext).length;
  const complete = labeled.filter(entry => entry.result.allEvidenceRetrieved).length;
  const matched = labeled.reduce((total, entry) => total + entry.result.matchedSessionIds.length, 0);
  const retrieved = labeled.reduce((total, entry) => total + entry.result.retrievedSessionIds.length, 0);
  const gold = labeled.reduce((total, entry) => total + entry.gold, 0);
  return { questions: rows.length, withRetrievedContext: withContext, emptyContext: rows.length - withContext,
    retrievedContextRate: rows.length ? withContext / rows.length : null, evidenceAnnotatedQuestions: labeled.length,
    completeEvidenceQuestions: complete, completeEvidenceRate: labeled.length ? complete / labeled.length : null,
    meanEvidenceSessionRecall: labeled.length ? labeled.reduce((sum, entry) => sum + entry.result.evidenceSessionRecall!, 0) / labeled.length : null,
    meanEvidenceSessionPrecision: labeled.length ? labeled.reduce((sum, entry) => sum + entry.result.evidenceSessionPrecision!, 0) / labeled.length : null,
    microEvidenceSessionRecall: gold ? matched / gold : null, microEvidenceSessionPrecision: labeled.length ? (retrieved ? matched / retrieved : 0) : null };
}

// Fixed ordinal IDs make tied cutoffs reproducible without deriving retrieval
// order from reference answers, evidence labels or original benchmark IDs.
function historyId(sessionIndex: number, turnIndex: number): string {
  const bytes = createHash('sha256').update(`longmemeval-history-v1:${sessionIndex}:${turnIndex}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Retrieval evaluation only: no answers are generated or judged. */
export async function runLongMemEval(input: unknown, options: LongMemEvalOptions = {}): Promise<LongMemEvalReport> {
  const started = performance.now(), budget = limits(options), deadline = started + budget.timeoutMs;
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error('signal must be an AbortSignal.');
  const check = () => { if (options.signal?.aborted) throw new Error('LongMemEval run cancelled.'); if (performance.now() >= deadline) throw new Error('LongMemEval time budget exceeded.'); };
  check();
  const dataset = decode(input, budget); check();
  const label = options.datasetLabel === undefined ? undefined : boundedText(1024).parse(options.datasetLabel);
  const revision = options.datasetRevision === undefined ? undefined : boundedText(1024).parse(options.datasetRevision);
  const calls = { embedding: 0, generation: 0 as const, judge: 0 as const, embeddingInputBytes: 0 };
  const supplied = options.embedder;
  if (supplied && (typeof supplied.embed !== 'function' || typeof supplied.model !== 'string' || !supplied.model.trim() || !Number.isInteger(supplied.dimensions) || supplied.dimensions < 1 || supplied.dimensions > 4096)) throw new Error('Invalid explicit embedder contract.');
  const embedder: MemoryEmbedder | undefined = supplied && { model: supplied.model, dimensions: supplied.dimensions, async embed(texts, operation) {
    check();
    const bytes = texts.reduce((total, value) => total + Buffer.byteLength(value), 0);
    if (calls.embedding >= budget.maxEmbeddingCalls || calls.embeddingInputBytes + bytes > budget.maxEmbeddingInputBytes) throw new Error('Embedding call or input byte budget exceeded.');
    calls.embedding++; calls.embeddingInputBytes += bytes;
    const controller = new AbortController();
    const signals = [...new Set([operation.signal, options.signal].filter((signal): signal is AbortSignal => !!signal))];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners: { signal: AbortSignal; listener: () => void }[] = [];
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        const cancel = (reason: unknown) => { controller.abort(reason); reject(reason); };
        for (const signal of signals) {
          const listener = () => cancel(signal.reason ?? new Error('LongMemEval run cancelled.'));
          if (signal.aborted) { listener(); return; }
          signal.addEventListener('abort', listener, { once: true }); listeners.push({ signal, listener });
        }
        timer = setTimeout(() => cancel(new Error('LongMemEval time budget exceeded.')), Math.max(1, Math.ceil(deadline - performance.now())));
      });
      const output = await Promise.race([Promise.resolve().then(() => {
        check(); controller.signal.throwIfAborted();
        return supplied.embed([...texts], { signal: controller.signal });
      }), cancelled]);
      check(); controller.signal.throwIfAborted(); return output;
    } finally {
      if (timer) clearTimeout(timer);
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
    }
  } };
  const names: LongMemEvalBaseline[] = embedder ? ['no-memory', 'lexical', 'hybrid'] : ['no-memory', 'lexical'];
  const parent = options.tempParent === undefined ? tmpdir() : resolve(boundedText(4096).parse(options.tempParent));
  const directory = mkdtempSync(join(parent, 'mnemosyne-longmemeval-'));
  const results: LongMemEvalQuestionResult[] = [];
  try {
    for (const [questionIndex, item] of dataset.cases.entries()) {
      check(); let clock = item.sessions[0]?.timestamp ?? item.questionTime;
      let memory: LocalMemory | undefined;
      try {
        memory = createLocalMemory({ path: join(directory, `question-${questionIndex}.sqlite`), workspaceId: 'longmemeval', agentId: 'retrieval-baseline', now: () => new Date(clock) });
        const references = new Map<string, Omit<LongMemEvalRetrieval, 'score'>>();
        let indexedTurns = 0, indexedBytes = 0;
        for (const [sessionIndex, session] of item.sessions.entries()) {
          clock = session.timestamp;
          for (let offset = 0; offset < session.turns.length; offset += 128) {
            const records: MemoryRecord[] = [];
            for (const [relative, turn] of session.turns.slice(offset, offset + 128).entries()) {
              check(); if (!turn.content.trim()) continue;
              const turnIndex = offset + relative;
              // Only history content is searchable or embeddable. Opaque ordinal
              // provenance prevents answer_-prefixed IDs and _abs labels leaking.
              const record: MemoryRecord = { id: historyId(sessionIndex, turnIndex), workspaceId: 'longmemeval', agentId: 'retrieval-baseline', visibility: 'private', status: 'active', createdAt: session.timestamp, updatedAt: session.timestamp, dependencies: [], text: turn.content, kind: 'observation', trust: 'observed',
                source: { uri: `longmemeval://history/session/${sessionIndex}/turn/${turnIndex}`, author: turn.role, observedAt: session.timestamp },
                metadata: { sessionIndex, turnIndex } };
              records.push(record);
              references.set(record.id, { sessionId: session.id, sessionDate: session.date, turnIndex, role: turn.role });
              indexedTurns++; indexedBytes += Buffer.byteLength(turn.content);
            }
            if (records.length) memory.import({ format: 'mnemosyne-local', version: 1, workspaceId: 'longmemeval', agentId: 'retrieval-baseline', exportedAt: session.timestamp, memories: records, outcomes: [] });
            await setImmediate(); check();
          }
        }
        clock = item.questionTime;
        const query = { query: item.question, limit: budget.topK, maxCandidates: budget.maxCandidates, asOf: item.questionTime, knownAt: item.questionTime };
        const convert = (hits: RecallResult[]) => hits.map(hit => {
          const reference = references.get(hit.memory.id);
          if (!reference) throw new Error('Retrieval returned an ID outside this question history.');
          return { ...reference, score: hit.score };
        });
        const baselines: LongMemEvalQuestionResult['baselines'] = { 'no-memory': score([], item.evidenceSessionIds), lexical: score(convert(memory.recall(query)), item.evidenceSessionIds) };
        check();
        if (embedder) {
          let remaining = indexedTurns;
          while (remaining > 0) {
            check();
            const indexed = await memory.indexEmbeddings({ embedder, limit: 1000, batchSize: 32, timeoutMs: Math.max(1, Math.min(60000, Math.floor(deadline - performance.now()))), signal: options.signal });
            if (indexed.remaining && !indexed.indexed) throw new Error('Embedding index made no progress.');
            remaining = indexed.remaining;
          }
          check();
          baselines.hybrid = score(convert(await memory.recallHybrid(query, { embedder, maxCandidates: budget.maxCandidates, timeoutMs: Math.max(1, Math.min(60000, Math.floor(deadline - performance.now()))), signal: options.signal })), item.evidenceSessionIds);
        }
        check();
        results.push({ questionId: item.questionId, questionType: item.questionType, questionDate: item.questionDate, answerability: item.unanswerable ? 'unanswerable' : 'answerable', evidenceSessionIds: [...item.evidenceSessionIds], historySessions: item.sessions.length, historyTurns: item.sessions.reduce((count, session) => count + session.turns.length, 0), indexedTurns, indexedBytes, baselines });
      } finally { memory?.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const summary: LongMemEvalReport['summary'] = {};
  for (const baseline of names) {
    const byQuestionType: Partial<Record<LongMemEvalQuestionType, LongMemEvalSummary>> = {};
    for (const type of questionTypes) { const selected = results.filter(row => row.questionType === type); if (selected.length) byQuestionType[type] = summarize(selected, baseline); }
    summary[baseline] = { all: summarize(results, baseline), answerable: summarize(results.filter(row => row.answerability === 'answerable'), baseline), unanswerable: summarize(results.filter(row => row.answerability === 'unanswerable'), baseline), byQuestionType };
  }
  return { kind: 'LongMemEval-style offline retrieval evaluation', protocol: 'v1-turn-retrieval-session-evidence', dataset: { origin: 'caller-supplied; official provenance not verified', ...(label ? { label } : {}), ...(revision ? { revision } : {}), sha256: dataset.sha256, bytes: dataset.bytes, questions: results.length }, granularity: 'turn', topK: budget.topK, providerMode: supplied ? 'caller-supplied-embedder' : 'none', ...(supplied ? { embeddingModel: { model: supplied.model, dimensions: supplied.dimensions } } : {}), calls, answerQuality: { status: 'not-evaluated', abstentionAccuracy: null }, results, summary, limits: budget, storage: 'fresh scoped SQLite per question; temporary files removed', durationMs: performance.now() - started,
    limitations: ['Retrieval scores do not measure answer correctness, reasoning quality or semantic abstention.', 'K counts retrieved turns; evidence metrics deduplicate their session IDs. These are not official session-retrieval-at-K results.', 'Questions without evidence-session labels have null evidence metrics and are excluded from evidence averages.', 'Naive benchmark timestamps are interpreted as UTC for chronological ordering; no real-world timezone is inferred.', 'Time budgets are checked between bounded SQLite operations; an individual synchronous operation cannot be preempted.', 'maxCandidates bounds lexical SQL candidates and the most-recent vector window. Hybrid fusion uses up to 100 ranked candidates per channel; it does not search every vector in larger histories.', 'No official dataset was downloaded or provenance authenticated by this runner. Caller embedding adapters determine their own networking and cost.'], protocolSources: LONGMEMEVAL_PROTOCOL_SOURCES };
}

/** Bounded regular-file JSON reader; callers must already possess the dataset. */
export async function runLongMemEvalFile(path: string, options: LongMemEvalOptions = {}): Promise<LongMemEvalReport> {
  const started = performance.now(), budget = limits(options);
  boundedText(4096).parse(path);
  const fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let content: string, fingerprint: { sha256: string; bytes: number };
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > budget.maxDatasetBytes) throw new Error('Dataset must be a regular JSON file within maxDatasetBytes.');
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) {
      if (options.signal?.aborted || performance.now() - started >= budget.timeoutMs) throw new Error('Dataset read cancelled or time budget exceeded.');
      const bytes = readSync(fd, buffer, length, buffer.length - length, null); if (!bytes) break; length += bytes;
    }
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Dataset changed during reading.');
    const raw = buffer.subarray(0, length);
    fingerprint = { sha256: createHash('sha256').update(raw).digest('hex'), bytes: length };
    content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } finally { closeSync(fd); }
  const remaining = Math.floor(budget.timeoutMs - (performance.now() - started));
  if (remaining < 1) throw new Error('Dataset read time budget exceeded.');
  const report = await runLongMemEval(content, { ...options, timeoutMs: remaining });
  return { ...report, dataset: { ...report.dataset, ...fingerprint }, limits: budget, durationMs: performance.now() - started };
}
