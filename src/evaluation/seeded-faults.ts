/**
 * A 10k-record store built from real LoCoMo text, and deterministic seeded
 * faults to plant in it.
 *
 * Two rules shape this file:
 *
 *  - **No synthetic filler.** The store reaches ten thousand records by
 *    materialising the corpus at several granularities — dialogue turns,
 *    per-session observations, session summaries, event summaries, and finally
 *    sentence-level splits of multi-sentence turns — not by generating text.
 *    The exact composition is returned and printed, whatever it comes to.
 *  - **The fault has to be the cause.** A question is only targeted if it
 *    passes before injection. A seeded record that displaces nothing is
 *    reported as such rather than dropped.
 *
 * Nothing here is imported by the library's default path: it exists for the
 * bisect harness.
 */
import { createHash } from 'node:crypto';
import type { LocalMemory } from '../local/index.js';
import type { JsonValue, MemoryRecord } from '../local/types.js';

export interface SeededQuestion {
  id: string;
  sampleId: string;
  query: string;
  answer: string;
  category: number;
  /** LoCoMo `dia_id`s. */
  evidence: string[];
  /** Record ids of the gold evidence turns. */
  gold: string[];
}

export interface StoreComposition {
  turns: number;
  observations: number;
  sessionSummaries: number;
  eventSummaries: number;
  sentences: number;
  total: number;
}

export interface SeededStore {
  composition: StoreComposition;
  questions: SeededQuestion[];
  /** Newest dated session in the corpus, ISO. The harness uses it as the cut point. */
  newest: string;
  /** Fixed ingestion instant. Never the wall clock. */
  ingestedAt: string;
}

const INGESTED_AT = '2020-01-01T00:00:00.000Z';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** Words too common to make a poison distinctive; keeping them only lengthens the record. */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'is', 'was', 'were', 'did', 'do', 'does', 'what', 'when', 'where', 'who', 'how', 'why', 'which', 'that', 'this', 'it', 'with', 'about', 'from', 'by', 'has', 'have', 'had', 'her', 'his', 'their', 'they', 'he', 'she']);

/** A UUID v4-shaped id derived from its inputs, so two runs build the same store. */
export function deterministicId(...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join(' ')).digest('hex');
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** `1:56 pm on 8 May, 2023` and `8 May, 2023` both occur in the corpus. */
export function locomoInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/.exec(value);
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[2].toLowerCase());
  if (month === -1) return undefined;
  const time = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(value);
  let hour = time ? Number(time[1]) % 12 : 12;
  if (time && time[3].toLowerCase() === 'pm') hour += 12;
  const instant = Date.UTC(Number(match[3]), month, Number(match[1]), hour, time ? Number(time[2]) : 0);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function record(
  id: string, text: string, uri: string, metadata: Record<string, JsonValue>,
  workspaceId: string, agentId: string, validFrom?: string,
): MemoryRecord {
  return {
    id, text, kind: 'observation', workspaceId, agentId, visibility: 'private', status: 'active',
    // Observed, not untrusted: an untrusted record never enters recall at all
    // (`includeUntrusted` defaults to false), and a corpus nobody can retrieve
    // measures nothing.
    trust: 'observed', source: { uri },
    createdAt: INGESTED_AT, updatedAt: INGESTED_AT,
    ...(validFrom === undefined ? {} : { validFrom }),
    dependencies: [], metadata,
  };
}

/** Sentence split on terminal punctuation. Deterministic, and never invents text. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(part => part.length > 24);
}

/**
 * Builds the store. Records are imported in batches through the snapshot path —
 * the same route `corpus-benchmark.ts` uses — because ten thousand individual
 * `store()` calls would spend the whole budget on ingestion.
 */
export function buildSeededStore(memory: LocalMemory, raw: unknown, options: { workspaceId: string; agentId: string; target?: number }): SeededStore {
  const target = options.target ?? 10_000;
  const { workspaceId, agentId } = options;
  const samples = Array.isArray(raw) ? raw : [];
  const composition: StoreComposition = { turns: 0, observations: 0, sessionSummaries: 0, eventSummaries: 0, sentences: 0, total: 0 };
  const records: MemoryRecord[] = [];
  const turnIds = new Map<string, string>();
  const questions: SeededQuestion[] = [];
  const spare: MemoryRecord[] = [];
  let newest = INGESTED_AT;

  for (const [sampleIndex, entry] of samples.entries()) {
    const sample = asObject(entry);
    const sampleId = String(sample.sample_id ?? `sample-${sampleIndex}`);
    const conversation = asObject(sample.conversation);
    const sessions = Object.keys(conversation).filter(key => /^session_\d+$/.test(key)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));

    for (const session of sessions) {
      const date = locomoInstant(conversation[`${session}_date_time`]);
      if (date && date > newest) newest = date;
      for (const rawTurn of Array.isArray(conversation[session]) ? conversation[session] as unknown[] : []) {
        const turn = asObject(rawTurn);
        const diaId = String(turn.dia_id ?? '');
        const text = String(turn.text ?? '');
        if (!diaId || !text) continue;
        const key = `${sampleId}/${diaId}`;
        const id = deterministicId('turn', key);
        turnIds.set(key, id);
        records.push(record(id, `${String(turn.speaker ?? 'speaker')}: ${text}`, `locomo://${sampleId}/${session}/${diaId}`,
          { granularity: 'turn', sampleId, session, diaId }, workspaceId, agentId, date));
        composition.turns++;
        // Sentence-level splits are held back and added only if the corpus is
        // short of the target, so the store is real text either way.
        const parts = sentences(text);
        if (parts.length < 2) continue;
        for (const [index, sentence] of parts.entries()) {
          spare.push(record(deterministicId('sentence', key, String(index)), sentence, `locomo://${sampleId}/${session}/${diaId}#s${index}`,
            { granularity: 'sentence', sampleId, session, diaId, sentence: index }, workspaceId, agentId, date));
        }
      }
    }

    for (const [key, value] of Object.entries(asObject(sample.observation))) {
      const session = key.replace(/_observation$/, '');
      const date = locomoInstant(conversation[`${session}_date_time`]);
      for (const [speaker, list] of Object.entries(asObject(value))) {
        for (const [index, item] of (Array.isArray(list) ? list : []).entries()) {
          const text = Array.isArray(item) ? String(item[0] ?? '') : String(item ?? '');
          if (!text) continue;
          records.push(record(deterministicId('observation', sampleId, key, speaker, String(index)), text,
            `locomo://${sampleId}/${session}/observation/${speaker}/${index}`,
            { granularity: 'observation', sampleId, session, speaker }, workspaceId, agentId, date));
          composition.observations++;
        }
      }
    }

    for (const [key, value] of Object.entries(asObject(sample.session_summary))) {
      const session = key.replace(/_summary$/, '');
      const text = String(value ?? '');
      if (!text) continue;
      records.push(record(deterministicId('session-summary', sampleId, key), text, `locomo://${sampleId}/${session}/summary`,
        { granularity: 'session-summary', sampleId, session }, workspaceId, agentId, locomoInstant(conversation[`${session}_date_time`])));
      composition.sessionSummaries++;
    }

    for (const [key, value] of Object.entries(asObject(sample.event_summary))) {
      const events = asObject(value);
      const date = locomoInstant(events.date);
      for (const [speaker, list] of Object.entries(events)) {
        if (speaker === 'date') continue;
        for (const [index, item] of (Array.isArray(list) ? list : []).entries()) {
          const text = String(item ?? '');
          if (!text) continue;
          records.push(record(deterministicId('event-summary', sampleId, key, speaker, String(index)), text,
            `locomo://${sampleId}/${key}/${speaker}/${index}`,
            { granularity: 'event-summary', sampleId, event: key, speaker }, workspaceId, agentId, date));
          composition.eventSummaries++;
        }
      }
    }

    for (const [index, rawQuestion] of (Array.isArray(sample.qa) ? sample.qa as unknown[] : []).entries()) {
      const question = asObject(rawQuestion);
      const evidence = (Array.isArray(question.evidence) ? question.evidence : []).map(String);
      const gold = evidence.map(diaId => turnIds.get(`${sampleId}/${diaId}`)).filter((id): id is string => id !== undefined);
      if (!gold.length || question.answer === undefined) continue;
      questions.push({
        id: `${sampleId}:${index}`, sampleId, query: String(question.question ?? ''), answer: String(question.answer),
        category: Number(question.category ?? 0), evidence, gold,
      });
    }
  }

  for (const filler of spare) {
    if (records.length >= target) break;
    records.push(filler);
    composition.sentences++;
  }
  composition.total = records.length;

  for (let offset = 0; offset < records.length; offset += 256) {
    memory.import({
      format: 'mnemosyne-local', version: 1, workspaceId, agentId, exportedAt: INGESTED_AT,
      memories: records.slice(offset, offset + 256), outcomes: [],
    });
  }

  return { composition, questions, newest, ingestedAt: INGESTED_AT };
}

/** The question's distinctive terms: what a poison record has to match to outrank the truth. */
export function distinctiveTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const token of query.toLowerCase().split(/[^a-z0-9']+/)) {
    if (token.length > 2 && !STOPWORDS.has(token)) seen.add(token);
  }
  return [...seen];
}

/**
 * A false value for `answer`, derived from the seed. Years shift, numbers
 * change, and anything else gets a deterministic suffix — so the poison reads
 * as a competing claim about the same thing rather than as noise.
 */
export function falseAnswer(answer: string, seed: string): string {
  const year = /(19|20)\d{2}/.exec(answer);
  if (year) return answer.replace(year[0], String(Number(year[0]) - 3));
  const number = /\d+/.exec(answer);
  if (number) return answer.replace(number[0], String(Number(number[0]) + 7));
  const digest = createHash('sha256').update(`${answer} ${seed}`).digest('hex');
  return `${answer.split(/\s+/)[0]}-${digest.slice(0, 6)}`;
}

export interface SeededFault { id: string; taskId: string; index: number; text: string }

/**
 * Plants `count` competing claims for one question. They are stored at the same
 * trust level as the corpus, carry an ordinary source, and are marked in
 * metadata only so the HARNESS can score the answer afterwards. `bisect` is
 * never told which records these are.
 */
export function injectSeededFaults(
  memory: LocalMemory, question: SeededQuestion,
  options: { count: number; seed: string; workspaceId: string; agentId: string; validFrom?: string },
): SeededFault[] {
  const terms = distinctiveTerms(question.query);
  const faults: SeededFault[] = [];
  const records: MemoryRecord[] = [];
  for (let index = 0; index < options.count; index++) {
    const wrong = falseAnswer(question.answer, `${options.seed}:${question.id}:${index}`);
    // The question's own terms plus a false value. A longer poison — a whole
    // rewritten turn — ranks BELOW the gold under BM25's length normalization,
    // so it would measure the scorer rather than the bisect.
    const text = `${terms.join(' ')} ${wrong}`;
    const id = deterministicId('fault', options.seed, question.id, String(index));
    records.push(record(id, text, `seeded://fault/${question.id}/${index}`,
      { granularity: 'seeded-fault', taskId: question.id, faultIndex: index },
      options.workspaceId, options.agentId, options.validFrom));
    faults.push({ id, taskId: question.id, index, text });
  }
  memory.import({
    format: 'mnemosyne-local', version: 1, workspaceId: options.workspaceId, agentId: options.agentId,
    exportedAt: INGESTED_AT, memories: records, outcomes: [],
  });
  return faults;
}
