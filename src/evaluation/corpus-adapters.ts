import type { CorpusDataset, CorpusProvenance, EvaluationLabel, EvaluationTurn } from './corpus-types.js';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a benchmark JSON object.');
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new Error('Expected a benchmark JSON array.'); return value; };
const text = (value: unknown, maximum = 16_777_216): string => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > maximum) throw new Error('Invalid or oversized benchmark text.');
  return value;
};
const identity = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return text(value, 1024);
};
function base(adapter: string, provenance: CorpusProvenance): CorpusDataset {
  text(provenance.dataset, 1024); text(provenance.revision, 1024); text(provenance.license, 1024);
  if (provenance.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(provenance.sourceSha256)) throw new Error('Invalid source SHA256.');
  if (provenance.sourceBytes !== undefined && (!Number.isSafeInteger(provenance.sourceBytes) || provenance.sourceBytes < 1)) throw new Error('Invalid source byte count.');
  return { protocol: 'mnemosyne-corpus-retrieval-v1', adapter, provenance: { ...provenance, verification: 'caller-supplied' }, corpora: [], questions: [], labels: [], notices: [] };
}
function addLabel(dataset: CorpusDataset, label: EvaluationLabel): void {
  label.evidenceGroups = [...new Set(label.evidenceGroups)];
  dataset.labels.push(label);
}
function isoDate(value: unknown): string {
  const raw = text(value, 128), match = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/.exec(raw);
  const iso = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z` : raw;
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(iso) || !Number.isFinite(Date.parse(iso))) throw new Error('Invalid benchmark date.');
  // Date.parse normalizes some impossible dates, including February 31.
  if (new Date(`${iso.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) !== iso.slice(0, 10)) throw new Error('Invalid benchmark calendar date.');
  const normalized = new Date(iso).toISOString();
  return normalized;
}

/** Cleaned S/M v1 shape; reference answers and has_answer are never history fields. */
export function adaptLongMemEvalCorpus(input: unknown, provenance: CorpusProvenance, options: { timestampPolicy?: 'strict-instant' | 'question-day' } = {}): CorpusDataset {
  const result = base('longmemeval-cleaned-v1', provenance);
  const policy = options.timestampPolicy ?? 'strict-instant';
  if (!['strict-instant', 'question-day'].includes(policy)) throw new Error('Invalid timestamp policy.');
  let laterSessions = 0;
  for (const [index, raw] of array(input).entries()) {
    const item = object(raw), questionId = identity(item.question_id), corpusId = `question-corpus:${index}`;
    const ids = array(item.haystack_session_ids), dates = array(item.haystack_dates), sessions = array(item.haystack_sessions);
    if (ids.length !== sessions.length || dates.length !== sessions.length) throw new Error('LongMemEval history arrays must align.');
    const questionTime = isoDate(item.question_date), cutoff = policy === 'question-day' ? `${questionTime.slice(0, 10)}T23:59:59.999Z` : questionTime;
    const turns: EvaluationTurn[] = [];
    const ordered = sessions.map((session, i) => ({ session, id: identity(ids[i]), date: isoDate(dates[i]), index: i })).sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index);
    for (const session of ordered) {
      if (session.date > cutoff) throw new Error('LongMemEval history exceeds the explicit question cutoff.');
      if (session.date > questionTime) laterSessions++;
      for (const [turnIndex, value] of array(session.session).entries()) {
        const turn = object(value);
        if (turn.role !== 'user' && turn.role !== 'assistant') throw new Error('Unsupported LongMemEval role.');
        if (turn.content === '') continue;
        turns.push({ id: `${session.index}:${turnIndex}`, text: text(turn.content), role: turn.role, date: session.date, evidenceGroups: [`session:${session.id}`] });
      }
    }
    const evidence = array(item.answer_session_ids).map(id => `session:${identity(id)}`);
    if (evidence.some(id => !ordered.some(session => `session:${session.id}` === id))) throw new Error('Unknown LongMemEval evidence session.');
    result.corpora.push({ id: corpusId, turns });
    result.questions.push({ id: questionId, corpusId, query: text(item.question, 4096), category: text(item.question_type, 256) });
    const reference = item.answer;
    addLabel(result, { questionId, evidenceGroups: evidence, answerability: questionId.endsWith('_abs') ? 'unanswerable' : 'answerable', answerSchema: typeof reference === 'string' ? 'text' : reference === undefined ? 'missing' : 'unsupported', ...(reference === undefined ? {} : { reference }) });
  }
  result.notices.push(`Timestamp policy: ${policy}; ${laterSessions} history sessions occur after the stated question instant. Source dates are preserved.`);
  result.notices.push('Unanswerable questions remain in attempt counts; their counterevidence labels are excluded from positive retrieval metrics.');
  return result;
}

/** Only original dialogue enters history; generated observations/summaries and qa stay out. */
export function adaptLoCoMoCorpus(input: unknown, provenance: CorpusProvenance): CorpusDataset {
  const result = base('locomo-original-dialogue-v1', provenance);
  for (const [index, raw] of array(input).entries()) {
    const sample = object(raw), conversation = object(sample.conversation), corpusId = `conversation:${index}`;
    const turns: EvaluationTurn[] = [];
    const sessions = Object.keys(conversation).filter(key => /^session_\d+$/.test(key)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
    for (const session of sessions) for (const rawTurn of array(conversation[session])) {
      const turn = object(rawTurn), id = identity(turn.dia_id);
      turns.push({ id, text: text(turn.text), speaker: text(turn.speaker, 256), ...(typeof conversation[`${session}_date_time`] === 'string' ? { date: text(conversation[`${session}_date_time`], 256) } : {}), evidenceGroups: [`turn:${id}`] });
    }
    const turnIds = new Set(turns.map(turn => turn.id));
    if (turnIds.size !== turns.length) throw new Error('Duplicate LoCoMo dialogue identity.');
    result.corpora.push({ id: corpusId, turns });
    for (const [qaIndex, rawQuestion] of array(sample.qa).entries()) {
      const question = object(rawQuestion), category = question.category;
      if (!Number.isSafeInteger(category) || Number(category) < 1 || Number(category) > 5) throw new Error('Unknown LoCoMo question category.');
      const questionId = `${identity(sample.sample_id ?? index)}:${qaIndex}`;
      const evidence = array(question.evidence ?? []).map(identity);
      if (evidence.some(id => !turnIds.has(id))) throw new Error('Unknown LoCoMo evidence dialogue.');
      result.questions.push({ id: questionId, corpusId, query: text(question.question, 4096), category: `locomo:${category}` });
      const reference = question.answer;
      addLabel(result, { questionId, evidenceGroups: evidence.map(id => `turn:${id}`), answerability: category === 5 ? 'unanswerable' : 'answerable', answerSchema: typeof reference === 'string' || typeof reference === 'number' ? 'text' : reference === undefined ? 'missing' : 'unsupported', ...(reference === undefined || category === 5 ? {} : { reference }) });
    }
  }
  result.notices.push('LoCoMo source timestamps have no timezone; raw dates are retained without inventing UTC instants. All five categories remain present, with category 5 separate from positive retrieval metrics.');
  result.notices.push('LoCoMo data is externally supplied under CC BY-NC 4.0, not distributed or relicensed by this package. This is not the official category-specific answer F1 evaluator.');
  return result;
}

function beamIds(value: unknown, depth = 0): string[] {
  if (depth > 8) throw new Error('BEAM evidence IDs exceed nesting bound.');
  if (Array.isArray(value)) { if (value.length > 10000) throw new Error('Too many BEAM evidence IDs.'); return value.flatMap(item => beamIds(item, depth + 1)); }
  if (value !== null && typeof value === 'object') { const values = Object.values(object(value)); if (values.length > 1000) throw new Error('Too many BEAM evidence groups.'); return values.flatMap(item => beamIds(item, depth + 1)); }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('BEAM source_chat_ids must contain nonnegative integer IDs.');
  return [String(value)];
}
/** Normalized repository JSON only; never eval Python-literal HF question strings. */
export function adaptBeamCorpus(chatInput: unknown, questionInput: unknown, provenance: CorpusProvenance): CorpusDataset {
  const result = base('beam-repository-json-v1', provenance), turns: EvaluationTurn[] = [];
  for (const batch of array(chatInput)) for (const conversation of array(object(batch).turns)) for (const raw of array(conversation)) {
    const turn = object(raw);
    if (turn.role !== 'user' && turn.role !== 'assistant') throw new Error('Unsupported BEAM role.');
    if (typeof turn.id !== 'number' || !Number.isSafeInteger(turn.id) || turn.id < 0) throw new Error('Invalid BEAM chat identity.');
    const id = String(turn.id);
    turns.push({ id, text: text(turn.content), role: turn.role, ...(typeof turn.time_anchor === 'string' ? { date: text(turn.time_anchor, 256) } : {}), evidenceGroups: [`turn:${id}`] });
  }
  const known = new Set(turns.map(turn => turn.id));
  if (known.size !== turns.length) throw new Error('Duplicate BEAM chat identity.');
  result.corpora.push({ id: 'beam-conversation', turns });
  for (const [category, rows] of Object.entries(object(questionInput))) for (const [index, raw] of array(rows).entries()) {
    const question = object(raw), questionId = `${category}:${index}`;
    const evidence = question.source_chat_ids === undefined ? [] : [...new Set(beamIds(question.source_chat_ids))];
    if (evidence.some(id => !known.has(id))) throw new Error('Unknown BEAM evidence chat ID.');
    const fields = ['answer', 'ideal_answer', 'ideal_response', 'ideal_summary', 'expected_compliance'] as const;
    const present = fields.filter(key => question[key] !== undefined);
    const reference = Object.fromEntries([...present, ...(question.rubric === undefined ? [] : ['rubric'])].map(key => [key, question[key]]));
    const supported = present.every(key => typeof question[key] === 'string') && (question.rubric === undefined || Array.isArray(question.rubric) && question.rubric.every(item => typeof item === 'string'));
    const answerSchema = !supported ? 'unsupported' : present.length ? 'text' : question.rubric !== undefined ? 'rubric-only' : 'missing';
    result.questions.push({ id: questionId, corpusId: 'beam-conversation', query: text(question.question, 4096), category: text(category, 256) });
    addLabel(result, { questionId, evidenceGroups: evidence.map(id => `turn:${id}`), answerability: category === 'abstention' ? 'unanswerable' : 'unknown', answerSchema, reference });
    if (answerSchema === 'unsupported') result.notices.push(`Unsupported answer/compliance schema retained for ${questionId}; no answer score is fabricated.`);
  }
  result.notices.push('BEAM reference answers, compliance requirements and rubrics remain private labels; disagreements are preserved rather than resolved by the adapter. Raw time anchors are not assumed to be message timestamps.');
  return result;
}
