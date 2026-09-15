import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GranularityLevel, GranularityOptions, MemoryRecord } from './types.js';

/**
 * Multi-granularity index: the same conversation, indexed a second and a third
 * time at coarser grain.
 *
 * A turn is often evidence only in context. "Yeah, I did that too" answers a
 * question only because of the three turns above it, so a retriever that scores
 * turns independently ranks it near the floor and a multi-evidence question loses
 * one of the turns it needed. Indexing the same content as overlapping session
 * windows and as one extractive summary per session gives those turns a second
 * and third way to be found: the window scores on the whole neighbourhood, and a
 * hit on it carries its member turns with it.
 *
 * Three properties are load-bearing and are what the rest of this file is shaped
 * around:
 *
 * 1. **Derived documents live in their own tables and never in `memories`.** No
 *    row is added to the canonical store and no existing query is modified, so
 *    turn-only retrieval is unchanged structurally rather than by promise.
 * 2. **A derived document is a pointer, never an authority.** It is never
 *    returned. It nominates member records, and every nominated record then
 *    passes the identical eligibility gate turn-level retrieval applies, so a
 *    derived hit can only ever surface a record that turn-level retrieval was
 *    already allowed to surface.
 * 3. **Derivation is deterministic and offline.** Summaries are extractive, with
 *    no model and no network anywhere on this path. The same records always
 *    produce the same bytes, which is what makes the index rebuildable and the
 *    benchmark reproducible.
 */

/** The engine's tokenizer, shared so the derived postings can never drift from
 * the turn-level ones. `LocalMemory#tokens` delegates here. */
export function tokenize(text: string): string[] {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export const GRANULARITY_DEFAULTS = Object.freeze({
  sessionKeys: Object.freeze(['sessionId', 'conversationId', 'threadId']) as readonly string[],
  windowTurns: 6,
  windowStride: 3,
  summarySentences: 5,
  summaryKeywords: 12,
  weight: 0.5,
  expandDocs: 12,
  expandTurns: 24,
  reserve: 16,
  rerankContext: 0,
  rerankContextTokens: 192,
  rerankContextTopN: 1000,
});

/** Iteration order for the derived levels, so a channel list is deterministic. */
export const GRANULARITY_LEVELS: readonly GranularityLevel[] = Object.freeze(['session', 'summary']);

export type ResolvedGranularityOptions = {
  sessionKeys: readonly string[]; windowTurns: number; windowStride: number; summarySentences: number;
  summaryKeywords: number; weight: number; expandDocs: number; expandTurns: number; reserve: number;
  rerankContext: number; rerankContextTokens: number; rerankContextTopN: number;
};

/**
 * Additive schema. Every statement is `IF NOT EXISTS` because the engine runs
 * this on every open, not only on creation.
 *
 * The two triggers on `memories` are what keep erasure whole at this new width.
 * A derived document holds a COPY of its members' text, so a member that is
 * erased, corrected, invalidated or retexted must not leave that copy behind:
 * both triggers destroy the whole document, and its postings and vectors go with
 * it by cascade. A later `indexGranularity()` rebuilds it from the survivors.
 * `BEFORE DELETE` is deliberate — it runs before the foreign-key cascade can
 * empty the membership table the trigger reads.
 *
 * `local_granularity_members(memory_id)` is indexed because both triggers filter
 * on it: without it every `forget()`, `correct()` and `checkpoint()` in every
 * database would pay a full scan of this table forever, including databases that
 * never build a derived index at all.
 */
export const GRANULARITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS local_granularity_docs(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    granularity TEXT NOT NULL,
    session_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT,
    members INTEGER NOT NULL,
    source_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS local_granularity_docs_scope ON local_granularity_docs(workspace_id,agent_id,granularity);
  CREATE TABLE IF NOT EXISTS local_granularity_members(
    doc_id TEXT NOT NULL REFERENCES local_granularity_docs(id) ON DELETE CASCADE,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY(doc_id,memory_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS local_granularity_members_memory ON local_granularity_members(memory_id);
  CREATE TABLE IF NOT EXISTS local_granularity_terms(
    doc_id TEXT NOT NULL REFERENCES local_granularity_docs(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    frequency INTEGER NOT NULL,
    PRIMARY KEY(doc_id,term)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS local_granularity_terms_term ON local_granularity_terms(term,doc_id);
  CREATE TABLE IF NOT EXISTS local_granularity_embeddings(
    doc_id TEXT NOT NULL REFERENCES local_granularity_docs(id) ON DELETE CASCADE,
    model TEXT NOT NULL REFERENCES local_embedding_models(model),
    dimensions INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY(doc_id,model)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS local_granularity_embeddings_model ON local_granularity_embeddings(model,doc_id);
  CREATE TRIGGER IF NOT EXISTS local_granularity_memory_bd BEFORE DELETE ON memories BEGIN
    DELETE FROM local_granularity_docs WHERE id IN (SELECT doc_id FROM local_granularity_members WHERE memory_id=old.id);
  END;
  CREATE TRIGGER IF NOT EXISTS local_granularity_memory_au AFTER UPDATE ON memories BEGIN
    DELETE FROM local_granularity_docs WHERE id IN (SELECT doc_id FROM local_granularity_members WHERE memory_id=new.id);
  END;
`;

export interface DerivationMember {
  id: string; text: string; createdAt: string; validFrom: string; validUntil: string | null; visibility: MemoryRecord['visibility'];
}

export interface DerivedDocument {
  id: string; granularity: GranularityLevel; sessionKey: string; ordinal: number; text: string;
  tokens: string[]; createdAt: string; validFrom: string; validUntil: string | null;
  visibility: MemoryRecord['visibility']; members: string[]; sourceHash: string;
}

/** Reads the session a record belongs to, or null when it declares none. A record
 * without a session key is simply never derived from; it stays turn-only. */
export function resolveSessionKey(record: Pick<MemoryRecord, 'metadata'>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record.metadata?.[key];
    if (typeof value === 'string' && value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= 512) return value;
  }
  return null;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Deterministic, content-independent identity: the same scope, level, session and
 * ordinal always name the same document, so an idempotent rebuild keeps the
 * vectors it already computed instead of re-embedding an unchanged corpus. */
const documentId = (workspaceId: string, agentId: string, granularity: GranularityLevel, sessionKey: string, ordinal: number): string =>
  digest(`granularity-v1\0${workspaceId}\0${agentId}\0${granularity}\0${sessionKey}\0${ordinal}`);

/** Intersection semantics: a derived document exists only inside the window where
 * EVERY member exists. Never earlier than its last member, never valid after its
 * first member stops being valid, and private unless every member is shared. This
 * is deliberately conservative — a derived document can never widen the time or
 * scope in which its content is visible. */
function envelope(members: DerivationMember[]): Pick<DerivedDocument, 'createdAt' | 'validFrom' | 'validUntil' | 'visibility'> {
  let createdAt = members[0].createdAt, validFrom = members[0].validFrom, validUntil = members[0].validUntil;
  let visibility: MemoryRecord['visibility'] = 'workspace';
  for (const member of members) {
    if (member.createdAt > createdAt) createdAt = member.createdAt;
    if (member.validFrom > validFrom) validFrom = member.validFrom;
    if (member.validUntil !== null && (validUntil === null || member.validUntil < validUntil)) validUntil = member.validUntil;
    if (member.visibility !== 'workspace') visibility = 'private';
  }
  return { createdAt, validFrom, validUntil, visibility };
}

/** Sentence boundaries for the extractive summary. Deliberately simple and
 * deterministic: terminal punctuation followed by whitespace, or a line break. */
function sentences(text: string): string[] {
  return text.split(/\n+|(?<=[.!?])\s+/u).map(part => part.trim()).filter(part => part.length > 0);
}

/**
 * One extractive summary per session, with no model anywhere on the path.
 *
 * Term salience is `tf_session * log(1 + sessions/df_session)` — a corpus-local
 * IDF over the sessions in this scope, which is what lets the summary prefer what
 * makes THIS session distinctive without needing a stopword list to suppress
 * "the" and "you" (they appear in nearly every session, so their IDF collapses).
 * Sentences are scored, the best `summarySentences` are taken, and they are then
 * emitted in their ORIGINAL order so the summary still reads as the session did.
 *
 * The IDF is over the sessions present at build time, so adding a session changes
 * every summary in the scope. That is the honest consequence of a corpus-local
 * weighting and it is why summaries are rebuilt wholesale; session windows, whose
 * text is just their members joined, are unaffected.
 */
function summarize(members: DerivationMember[], idf: Map<string, number>, options: ResolvedGranularityOptions): string {
  const scored: { index: number; text: string; score: number }[] = [];
  let index = 0;
  const salience = new Map<string, number>();
  for (const member of members) {
    for (const sentence of sentences(member.text)) {
      const tokens = tokenize(sentence);
      if (!tokens.length) { index++; continue; }
      const frequencies = new Map<string, number>();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      let score = 0;
      for (const [term, count] of frequencies) {
        const weight = idf.get(term) ?? 0;
        score += weight * (1 + Math.log(count));
        salience.set(term, (salience.get(term) ?? 0) + weight * count);
      }
      scored.push({ index: index++, text: sentence, score: score / Math.sqrt(tokens.length) });
    }
  }
  // Ties break on original position, so the summary of a given session is one
  // fixed string rather than one of several equally good strings.
  const chosen = [...scored].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, options.summarySentences).sort((a, b) => a.index - b.index);
  const keywords = [...salience.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, options.summaryKeywords).map(entry => entry[0]);
  return [keywords.join(' '), ...chosen.map(entry => entry.text)].join('\n');
}

/**
 * Derives every session and summary document for one (workspace, agent) scope.
 *
 * Members are grouped by session key by the caller; each group must already be in
 * a stable order. Session documents are sliding windows of `windowTurns` members
 * with stride `windowStride`, so evidence split across a window boundary is still
 * covered whole by the neighbouring window. Windows rather than whole sessions
 * because the embedder truncates at 512 tokens: a whole-session vector would only
 * ever see the session's opening.
 */
export function deriveDocuments(scope: { workspaceId: string; agentId: string }, sessions: Map<string, DerivationMember[]>, options: ResolvedGranularityOptions): DerivedDocument[] {
  const documentFrequency = new Map<string, number>();
  const sessionTerms = new Map<string, Map<string, number>>();
  for (const [key, members] of sessions) {
    const frequencies = new Map<string, number>();
    for (const member of members) for (const token of tokenize(member.text)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    sessionTerms.set(key, frequencies);
    for (const term of frequencies.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const total = sessions.size;
  const idf = new Map([...documentFrequency].map(([term, count]) => [term, Math.log(1 + total / count)]));

  const documents: DerivedDocument[] = [];
  const emit = (granularity: GranularityLevel, sessionKey: string, ordinal: number, text: string, members: DerivationMember[]): void => {
    const tokens = tokenize(text);
    if (!tokens.length) return;
    documents.push({
      id: documentId(scope.workspaceId, scope.agentId, granularity, sessionKey, ordinal),
      granularity, sessionKey, ordinal, text, tokens, ...envelope(members),
      // The hash covers the membership as well as the text, so "unchanged" means
      // the same document and not merely the same bytes.
      members: members.map(member => member.id), sourceHash: digest(`${text}\0${members.map(member => member.id).join(',')}`),
    });
  };
  // Sorted so the derived set is a function of the record set alone, never of the
  // order SQLite happened to return groups in.
  for (const sessionKey of [...sessions.keys()].sort()) {
    const members = sessions.get(sessionKey)!;
    if (!members.length) continue;
    let ordinal = 0;
    for (let start = 0; start < members.length; start += options.windowStride) {
      const window = members.slice(start, start + options.windowTurns);
      if (!window.length) break;
      emit('session', sessionKey, ordinal++, window.map(member => member.text).join('\n'), window);
      // A final short window that the stride would repeat adds nothing.
      if (start + options.windowTurns >= members.length) break;
    }
    emit('summary', sessionKey, 0, summarize(members, idf, options), members);
  }
  return documents;
}

/* ------------------------------------------------------------------------- */
/* Storage                                                                     */
/* ------------------------------------------------------------------------- */

export interface GranularityIndexCounts { sessions: number; documents: number; inserted: number; removed: number; unchanged: number }

/**
 * Replaces this scope's derived documents with the ones the current records
 * imply, touching only what actually changed.
 *
 * Documents whose identity AND content are unchanged are left alone, which is
 * what keeps an idempotent rebuild from throwing away vectors it would only have
 * to recompute. Everything else in this scope is removed, so a rebuild after a
 * correction or an erasure cannot leave an orphan behind.
 */
export function writeDocuments(db: DatabaseSync, scope: { workspaceId: string; agentId: string }, documents: DerivedDocument[]): GranularityIndexCounts {
  const existing = new Map((db.prepare('SELECT id,source_hash FROM local_granularity_docs WHERE workspace_id=? AND agent_id=?')
    .all(scope.workspaceId, scope.agentId) as { id: string; source_hash: string }[]).map(row => [row.id, row.source_hash]));
  const wanted = new Map(documents.map(document => [document.id, document]));
  let removed = 0, inserted = 0, unchanged = 0;
  const drop = db.prepare('DELETE FROM local_granularity_docs WHERE id=?');
  for (const [id, hash] of existing) {
    if (wanted.get(id)?.sourceHash === hash) { unchanged++; continue; }
    drop.run(id); removed++;
  }
  const insertDoc = db.prepare(`INSERT INTO local_granularity_docs(id,workspace_id,agent_id,visibility,granularity,session_key,ordinal,text,token_count,created_at,valid_from,valid_until,members,source_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertMember = db.prepare('INSERT INTO local_granularity_members(doc_id,memory_id,position) VALUES(?,?,?)');
  const insertTerm = db.prepare('INSERT INTO local_granularity_terms(doc_id,term,frequency) VALUES(?,?,?)');
  for (const document of documents) {
    if (existing.get(document.id) === document.sourceHash) continue;
    insertDoc.run(document.id, scope.workspaceId, scope.agentId, document.visibility, document.granularity, document.sessionKey, document.ordinal,
      document.text, document.tokens.length, document.createdAt, document.validFrom, document.validUntil, document.members.length, document.sourceHash);
    document.members.forEach((memberId, position) => insertMember.run(document.id, memberId, position));
    const frequencies = new Map<string, number>();
    for (const token of document.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [term, frequency] of frequencies) insertTerm.run(document.id, term, frequency);
    inserted++;
  }
  return { sessions: new Set(documents.map(document => document.sessionKey)).size, documents: documents.length, inserted, removed, unchanged };
}

/* ------------------------------------------------------------------------- */
/* Retrieval over the derived index                                            */
/* ------------------------------------------------------------------------- */

export interface DerivedScore { id: string; granularity: GranularityLevel; score: number }
export interface DerivedScan { workspaceId: string; agentId: string; asOf: string; knownAt: string }

const SCOPE_SQL = `d.workspace_id=? AND (d.agent_id=? OR d.visibility='workspace')
  AND d.created_at<=? AND d.valid_from<=? AND (d.valid_until IS NULL OR d.valid_until>?)`;
const scopeParameters = (scan: DerivedScan): string[] => [scan.workspaceId, scan.agentId, scan.knownAt, scan.asOf, scan.asOf];

/**
 * BM25 over the derived postings, in ONE pass that covers both levels.
 *
 * Session windows and session summaries have very different lengths, so they are
 * scored as two separate collections — mixing them would corrupt the average
 * document length that BM25 normalises against — but they share the single
 * posting scan, which is why adding a second derived level costs no extra scan.
 */
export function lexicalDerived(db: DatabaseSync, terms: string[], scan: DerivedScan, limit: number): DerivedScore[] {
  if (!terms.length) return [];
  const placeholders = terms.map(() => '?').join(',');
  const collections = new Map<GranularityLevel, { documents: number; totalLength: number }>();
  for (const row of db.prepare(`SELECT d.granularity AS granularity,count(*) AS documents,sum(d.token_count) AS length
    FROM local_granularity_docs d WHERE ${SCOPE_SQL} GROUP BY d.granularity`).all(...scopeParameters(scan)) as { granularity: GranularityLevel; documents: number; length: number }[]) {
    collections.set(row.granularity, { documents: row.documents, totalLength: row.length });
  }
  if (!collections.size) return [];
  const frequency = new Map<string, Map<GranularityLevel, number>>();
  for (const row of db.prepare(`SELECT t.term AS term,d.granularity AS granularity,count(*) AS documents
    FROM local_granularity_terms t INDEXED BY local_granularity_terms_term JOIN local_granularity_docs d ON d.id=t.doc_id
    WHERE t.term IN (${placeholders}) AND ${SCOPE_SQL} GROUP BY t.term,d.granularity`)
    .all(...terms, ...scopeParameters(scan)) as { term: string; granularity: GranularityLevel; documents: number }[]) {
    const byLevel = frequency.get(row.term) ?? new Map<GranularityLevel, number>();
    byLevel.set(row.granularity, row.documents); frequency.set(row.term, byLevel);
  }
  if (!frequency.size) return [];
  const scored: DerivedScore[] = [];
  for (const value of db.prepare(`WITH matches AS MATERIALIZED (
      SELECT doc_id,json_group_array(json_array(term,frequency)) AS frequencies
      FROM local_granularity_terms INDEXED BY local_granularity_terms_term WHERE term IN (${placeholders}) GROUP BY doc_id
    ) SELECT d.id AS id,d.granularity AS granularity,d.token_count AS token_count,m.frequencies AS frequencies
    FROM matches m JOIN local_granularity_docs d ON d.id=m.doc_id WHERE ${SCOPE_SQL}`).iterate(...terms, ...scopeParameters(scan))) {
    const row = value as { id: string; granularity: GranularityLevel; token_count: number; frequencies: string };
    const collection = collections.get(row.granularity);
    if (!collection || !collection.documents) continue;
    const averageLength = collection.totalLength / collection.documents;
    let score = 0;
    for (const [term, occurrences] of JSON.parse(row.frequencies) as [string, number][]) {
      const df = frequency.get(term)?.get(row.granularity);
      if (df === undefined) continue;
      const idf = Math.log1p((collection.documents - df + 0.5) / (df + 0.5));
      score += idf * (occurrences * 2.2) / (occurrences + 1.2 * (0.25 + 0.75 * row.token_count / (averageLength || 1)));
    }
    if (score > 0) scored.push({ id: row.id, granularity: row.granularity, score });
  }
  return rank(scored, limit);
}

/** Exact cosine over the derived vectors, one scan covering both levels. */
export function denseDerived(db: DatabaseSync, model: string, dimensions: number, query: number[], scan: DerivedScan, limit: number, check?: () => void): DerivedScore[] {
  const statement = db.prepare(`SELECT e.doc_id AS id,d.granularity AS granularity,e.data AS vector,e.source_hash AS source_hash,d.source_hash AS current
    FROM local_granularity_embeddings e JOIN local_granularity_docs d ON d.id=e.doc_id
    WHERE e.model=? AND e.dimensions=? AND e.doc_id>? AND ${SCOPE_SQL} ORDER BY e.doc_id LIMIT 256`);
  const scored: DerivedScore[] = [];
  let cursor = '';
  for (;;) {
    check?.();
    const rows = statement.all(model, dimensions, cursor, ...scopeParameters(scan)) as { id: string; granularity: GranularityLevel; vector: string; source_hash: string; current: string }[];
    for (const row of rows) {
      cursor = row.id;
      // A vector computed from text the document no longer has is not evidence about it.
      if (row.source_hash !== row.current) continue;
      const vector = JSON.parse(row.vector) as number[];
      if (!Array.isArray(vector) || vector.length !== dimensions) continue;
      let score = 0;
      for (let index = 0; index < dimensions; index++) score += vector[index] * query[index];
      // Nonpositive cosine is not affirmative semantic evidence, exactly as on the turn path.
      if (score > 0) scored.push({ id: row.id, granularity: row.granularity, score });
    }
    if (rows.length < 256) break;
  }
  return rank(scored, limit);
}

function rank(scored: DerivedScore[], limit: number): DerivedScore[] {
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

export interface ExpansionResult { contributions: Map<string, number>; docs: number; turns: number }

/**
 * Turns a ranked list of derived documents into per-member contributions.
 *
 * Every member of a document inherits the document's OWN rank rather than a
 * position in a flattened list, because members of one window are siblings and
 * ordering them against each other would be an artefact of the expansion rather
 * than a measurement. Within one channel a turn that appears in two overlapping
 * windows takes the MAX of the two contributions, never the sum, so overlap
 * cannot manufacture score.
 *
 * Both caps are on MEMBER count as well as document count. A summary document is
 * a whole session — on LoCoMo a mean of 21.6 records — so a cap expressed only in
 * documents would let one channel inject several hundred records into a rerank
 * pool of fifty.
 */
export function expand(ranked: DerivedScore[], members: Map<string, string[]>, rrfK: number, weight: number, options: { docs: number; turns: number }): ExpansionResult {
  const contributions = new Map<string, number>();
  let docs = 0;
  for (const [rank, document] of ranked.entries()) {
    if (docs >= options.docs || contributions.size >= options.turns) break;
    const memberIds = members.get(document.id);
    if (!memberIds?.length) continue;
    docs++;
    const contribution = weight / (rrfK + rank + 1);
    for (const memberId of memberIds) {
      if (!contributions.has(memberId) && contributions.size >= options.turns) continue;
      const previous = contributions.get(memberId);
      if (previous === undefined || contribution > previous) contributions.set(memberId, contribution);
    }
  }
  return { contributions, docs, turns: contributions.size };
}

/** Member ids for a set of derived documents, in stored order. */
export function membersOf(db: DatabaseSync, ids: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!ids.length) return result;
  for (const value of db.prepare(`SELECT doc_id,memory_id FROM local_granularity_members WHERE doc_id IN (${ids.map(() => '?').join(',')}) ORDER BY doc_id,position`).iterate(...ids)) {
    const row = value as { doc_id: string; memory_id: string };
    const list = result.get(row.doc_id) ?? [];
    list.push(row.memory_id); result.set(row.doc_id, list);
  }
  return result;
}

/** A turn adjacent to a candidate inside a derived session window. */
export interface SessionNeighbour { id: string; offset: number }

/**
 * The in-session neighbours of each id, out to `radius` turns either side.
 *
 * This reads the derived layer for its ADJACENCY, never for its text. The stored
 * window text cannot be reused verbatim for reranking: every member of one window
 * would get an identical passage and therefore an identical score, which is the
 * already-rejected session-endorsement variant wearing a different coat.
 *
 * Because `windowStride` is smaller than `windowTurns`, an interior turn belongs
 * to two overlapping windows. Taking the UNION across every window that contains
 * it — rather than picking one "most centred" window — is what makes the
 * neighbourhood symmetric: a turn sitting at the edge of one window sits in the
 * middle of the next, and the rows are already in hand, so the union costs no
 * extra query. Each neighbour keeps the SMALLEST distance any window gives it.
 *
 * Scoping is the same `SCOPE_SQL` every other derived read uses. Without it this
 * would be the one query in the file that can see another workspace's documents.
 */
export function sessionNeighbours(db: DatabaseSync, ids: readonly string[], scan: DerivedScan, radius: number): Map<string, SessionNeighbour[]> {
  const result = new Map<string, SessionNeighbour[]>();
  if (!ids.length || radius < 1) return result;
  const placements = new Map<string, { docId: string; position: number }[]>();
  const documents = new Set<string>();
  // Chunked because the rerank head can exceed SQLite's variable limit on its own.
  for (let offset = 0; offset < ids.length; offset += 256) {
    const chunk = ids.slice(offset, offset + 256);
    for (const value of db.prepare(`SELECT m.memory_id AS memory_id,m.doc_id AS doc_id,m.position AS position
      FROM local_granularity_members m JOIN local_granularity_docs d ON d.id=m.doc_id
      WHERE d.granularity='session' AND m.memory_id IN (${chunk.map(() => '?').join(',')}) AND ${SCOPE_SQL}
      ORDER BY m.doc_id,m.position`).iterate(...chunk, ...scopeParameters(scan))) {
      const row = value as { memory_id: string; doc_id: string; position: number };
      const list = placements.get(row.memory_id) ?? [];
      list.push({ docId: row.doc_id, position: row.position }); placements.set(row.memory_id, list);
      documents.add(row.doc_id);
    }
  }
  if (!documents.size) return result;
  const members = membersOf(db, [...documents].sort());
  for (const [id, sites] of placements) {
    const nearest = new Map<string, number>();
    for (const site of sites) {
      const ordered = members.get(site.docId);
      if (!ordered) continue;
      for (let step = -radius; step <= radius; step++) {
        const neighbour = step === 0 ? undefined : ordered[site.position + step];
        if (neighbour === undefined || neighbour === id) continue;
        const previous = nearest.get(neighbour);
        if (previous === undefined || Math.abs(step) < Math.abs(previous)) nearest.set(neighbour, step);
      }
    }
    if (nearest.size) {
      result.set(id, [...nearest].map(([neighbour, offset]) => ({ id: neighbour, offset }))
        .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset) || Math.sign(a.offset) - Math.sign(b.offset) || a.id.localeCompare(b.id)));
    }
  }
  return result;
}

export function resolveOptions(options: GranularityOptions | undefined): ResolvedGranularityOptions {
  const input = options ?? {};
  const integer = (value: number | undefined, fallback: number, min: number, max: number, label: string): number => {
    const actual = value ?? fallback;
    if (!Number.isSafeInteger(actual) || actual < min || actual > max) throw new TypeError(`granularity.${label} must be an integer between ${min} and ${max}`);
    return actual;
  };
  const sessionKeys = input.sessionKeys === undefined ? GRANULARITY_DEFAULTS.sessionKeys : input.sessionKeys;
  if (!Array.isArray(sessionKeys) || !sessionKeys.length || sessionKeys.length > 8 || sessionKeys.some(key => typeof key !== 'string' || !key.trim() || key.length > 64)) {
    throw new TypeError('granularity.sessionKeys must be 1-8 nonempty metadata key names');
  }
  const weight = input.weight ?? GRANULARITY_DEFAULTS.weight;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 4) throw new TypeError('granularity.weight must be between 0 and 4');
  const windowTurns = integer(input.windowTurns, GRANULARITY_DEFAULTS.windowTurns, 1, 256, 'windowTurns');
  const windowStride = integer(input.windowStride, GRANULARITY_DEFAULTS.windowStride, 1, 256, 'windowStride');
  if (windowStride > windowTurns) throw new TypeError('granularity.windowStride cannot exceed granularity.windowTurns, or records would fall between windows');
  return {
    sessionKeys: [...sessionKeys], windowTurns, windowStride,
    summarySentences: integer(input.summarySentences, GRANULARITY_DEFAULTS.summarySentences, 1, 64, 'summarySentences'),
    summaryKeywords: integer(input.summaryKeywords, GRANULARITY_DEFAULTS.summaryKeywords, 1, 128, 'summaryKeywords'),
    weight,
    expandDocs: integer(input.expandDocs, GRANULARITY_DEFAULTS.expandDocs, 1, 500, 'expandDocs'),
    expandTurns: integer(input.expandTurns, GRANULARITY_DEFAULTS.expandTurns, 1, 2000, 'expandTurns'),
    reserve: integer(input.reserve, GRANULARITY_DEFAULTS.reserve, 0 as number, 500, 'reserve'),
    rerankContext: integer(input.rerankContext, GRANULARITY_DEFAULTS.rerankContext, 0 as number, 4, 'rerankContext'),
    rerankContextTokens: integer(input.rerankContextTokens, GRANULARITY_DEFAULTS.rerankContextTokens, 0 as number, 448, 'rerankContextTokens'),
    rerankContextTopN: integer(input.rerankContextTopN, GRANULARITY_DEFAULTS.rerankContextTopN, 1, 1000, 'rerankContextTopN'),
  };
}
