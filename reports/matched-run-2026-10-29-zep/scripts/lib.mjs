// Shared driver pieces for the 2026-10-29 Zep matched run.
// Everything scored goes through the repository's own compiled harness (wt/dist) and its
// unmodified Zep adapter. The only thing added here is a ZepLikeClient that wraps the real
// @getzep/zep-cloud ZepClient and records which episode uuid each chunk received, so one
// paid ingestion per conversation can serve the K=5, 10 and 20 passes.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname;
export const WT = join(ROOT, 'wt');
export const DIST = join(WT, 'dist');
export const COMPETITORS = join(WT, 'benchmarks', 'competitors');
export const STATE = join(ROOT, 'state');
export const KEY_ENV = process.env.ZEP_KEY_ENV || 'ZEP_API_KEY_FREE';
export const USER_PREFIX = 'mnemo-zeprun-20261029-';

const require = createRequire(join(COMPETITORS, 'package.json'));
const pacer = { next: 0 };
export const ZEP_VERSION = JSON.parse(readFileSync(require.resolve('@getzep/zep-cloud/package.json'), 'utf8')).version;
export const sha = text => createHash('sha256').update(text).digest('hex');
export const credits = data => Math.max(1, Math.ceil(Buffer.byteLength(data) / 350));
export const userFor = harnessUser => USER_PREFIX + harnessUser.replace(/[^A-Za-z0-9_-]/g, '_');

export function realClient() {
  const { ZepClient } = require('@getzep/zep-cloud');
  const key = process.env[KEY_ENV];
  if (!key) throw new Error(`${KEY_ENV} is not set`);
  return new ZepClient({ apiKey: key });
}

/**
 * A ZepLikeClient over the real SDK.
 * mode 'ingest': graph.add calls Zep unless the chunk is already recorded (resumable).
 * mode 'replay': graph.add NEVER calls Zep. It returns the recorded uuid and throws if the
 * chunk is unknown or its payload differs, so the scored pass is proven to use exactly the
 * episodes the paid pass loaded. search / getByUserId / delete always hit the real API.
 */
export function recordingClient(real, mode, stats) {
  const file = join(STATE, 'episodes.jsonl');
  const known = new Map();
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue; const e = JSON.parse(line); known.set(`${e.user}\x00${e.chunk}`, e);
  }
  const usersFile = join(STATE, 'users.jsonl');
  const users = new Set(existsSync(usersFile) ? readFileSync(usersFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).user) : []);
  // Global pacing under the account's 300 RPM, and 429 backoff (a 429 is a rejected request, so retrying it cannot double-ingest).
  const rpm = Number(process.env.ZEP_RPM || 200);
  const call = async (label, fn) => {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now(), slot = Math.max(now, pacer.next); pacer.next = slot + 60_000 / rpm;
      if (slot > now) { await new Promise(r => setTimeout(r, slot - now)); stats.pacedMs = (stats.pacedMs ?? 0) + (slot - now); if (label === 'graph.search') stats.searchPacedMs = (stats.searchPacedMs ?? 0) + (slot - now); }
      stats.calls[label] = (stats.calls[label] ?? 0) + 1;
      const t0 = performance.now();
      try { const out = await fn(); if (label === 'graph.search') (stats.searchNetMs ??= []).push(Math.round(performance.now() - t0)); return out; }
      catch (e) {
        if (e?.statusCode !== 429 || attempt >= 8) throw e;
        const after = Number(e?.rawResponse?.headers?.get?.('retry-after')) || 30;
        stats.rateLimited = (stats.rateLimited ?? 0) + 1;
        pacer.next = Math.max(pacer.next, Date.now() + after * 1000);
      }
    }
  };
  return {
    known, users,
    user: {
      async add({ userId }) {
        const u = userFor(userId);
        if (users.has(u)) return {};
        if (mode === 'replay') throw new Error(`replay: user ${u} was never created`);
        const r = await call('user.add', () => real.user.add({ userId: u }));
        users.add(u); appendFileSync(usersFile, JSON.stringify({ user: u, harnessUser: userId, at: new Date().toISOString() }) + '\n');
        return r;
      },
      async delete(userId) { return call('user.delete', () => real.user.delete(userFor(userId))); },
    },
    graph: {
      async add(req) {
        const u = userFor(req.userId), chunk = req.metadata?.matched_chunk_id, digest = sha(req.data);
        const hit = known.get(`${u}\x00${chunk}`);
        if (hit) {
          if (hit.dataSha256 !== digest) throw new Error(`payload mismatch for chunk ${chunk}`);
          stats.replayed++; return { uuid: hit.uuid };
        }
        if (mode === 'replay') throw new Error(`replay: chunk ${chunk} was never ingested`);
        const ep = await call('graph.add', () => real.graph.add({ ...req, userId: u }));
        const rec = { user: u, chunk, uuid: ep?.uuid ?? '', bytes: Buffer.byteLength(req.data), credits: credits(req.data), dataSha256: digest, at: new Date().toISOString() };
        known.set(`${u}\x00${chunk}`, rec); appendFileSync(file, JSON.stringify(rec) + '\n');
        stats.added++; stats.credits += rec.credits;
        return ep;
      },
      async search(req) {
        const r = await call('graph.search', () => real.graph.search({ ...req, userId: userFor(req.userId) }));
        // Diagnostic only (ZEP_SORT_BY_SCORE=1): Zep returns episodes in roughly creation order with a
        // per-episode score attached; this re-sorts by that score, descending, before the adapter ranks.
        if (process.env.ZEP_SORT_BY_SCORE === '1' && Array.isArray(r?.episodes)) r.episodes = [...r.episodes].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
        return r;
      },
      episode: {
        async getByUserId(userId, req) {
          const r = await call('graph.episode.getByUserId', () => real.graph.episode.getByUserId(userFor(userId), req));
          const eps = r.episodes ?? [];
          stats.lastPoll = { user: userFor(userId), returned: eps.length, unprocessed: eps.filter(e => e.processed === false).length, at: new Date().toISOString() };
          return r;
        },
        async delete(uuid) { return call('graph.episode.delete', () => real.graph.episode.delete(uuid)); },
      },
    },
  };
}

/** The harness's own chunking and identities, reproduced only to drive the pre-ingest; the scored
 * pass re-derives them inside runCorpusBenchmark and the replay client rejects any difference. */
export async function harnessChunks(corpus, corpusIndexAbsolute) {
  const { splitEvaluationText } = await import(join(DIST, 'evaluation', 'corpus-benchmark.js'));
  const out = [];
  for (const [turnIndex, turn] of corpus.turns.entries()) for (const piece of splitEvaluationText(turn.text, 4096)) {
    const f = sha(`corpus-v1:${corpusIndexAbsolute}:${turnIndex}:${piece.startByte}`);
    const id = `${f.slice(0, 8)}-${f.slice(8, 12)}-4${f.slice(13, 16)}-8${f.slice(17, 20)}-${f.slice(20, 32)}`;
    out.push({ id, text: piece.text, ...(turn.role ? { role: turn.role } : {}), ...(turn.speaker ? { speaker: turn.speaker } : {}), ...(turn.date ? { date: turn.date } : {}) });
  }
  return out;
}

// Copied from src/evaluation/matched-benchmark.ts (not exported there), unchanged in behaviour.
const LOCOMO = { file: 'locomo10.json', label: 'LoCoMo (locomo10)', provenance: { dataset: 'locomo10', revision: 'snap-research/locomo main', license: 'CC BY-NC 4.0', sourceUrl: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json' } };
const LONGMEMEVAL = { file: 'longmemeval_s_cleaned.json', label: 'LongMemEval-S (cleaned)', provenance: { dataset: 'xiaowu0162/longmemeval-cleaned', revision: '98d7416c24c778c2fee6e6f3006e7a073259d48f', license: 'MIT per dataset card', sourceUrl: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json' } };
export const SPECS = { locomo: LOCOMO, longmemeval: LONGMEMEVAL };

export async function loadCorpus(kind, questionLimit, stride = 1) {
  const { adaptLoCoMoCorpus, adaptLongMemEvalCorpus } = await import(join(DIST, 'evaluation', 'corpus-benchmark.js'));
  const file = join(WT, 'benchmarks', 'data', SPECS[kind].file);
  const raw = readFileSync(file);
  const sha256 = sha(raw);
  const parsed = JSON.parse(raw.toString('utf8'));
  const provenance = { ...SPECS[kind].provenance, sourceSha256: sha256, sourceBytes: raw.byteLength };
  if (kind === 'locomo') return { dataset: adaptLoCoMoCorpus(parsed, provenance, { onMalformedEvidence: 'skip' }), sha256, bytes: raw.byteLength };
  let entries = parsed;
  if (Array.isArray(entries) && stride > 1) entries = entries.filter((_, index) => index % stride === 0);
  if (Array.isArray(entries) && questionLimit !== undefined) entries = entries.slice(0, questionLimit);
  return { dataset: adaptLongMemEvalCorpus(entries, provenance, { timestampPolicy: 'question-day' }), sha256, bytes: raw.byteLength };
}

export function sliceCorpus(dataset, maxCorpora, maxQuestions, offset = 0) {
  const from = dataset.corpora.slice(offset);
  const corpora = maxCorpora !== undefined ? from.slice(0, maxCorpora) : from;
  const ids = new Set(corpora.map(c => c.id));
  let questions = dataset.questions.filter(q => ids.has(q.corpusId));
  if (maxQuestions !== undefined) questions = questions.slice(0, maxQuestions);
  const kept = new Set(questions.map(q => q.id));
  const used = new Set(questions.map(q => q.corpusId));
  return { ...dataset, corpora: corpora.filter(c => used.has(c.id)), questions, labels: dataset.labels.filter(l => kept.has(l.questionId)) };
}
