/**
 * Precision controls for recall: score floors, the name/alias phrase gate, the
 * metadata predicate and the lifecycle prefilter.
 *
 * Kept out of the kernel file so each piece is a pure function with its own
 * tests. Nothing here reads the database or the clock; `LocalMemory` supplies
 * the rows and the temporal view, and decides what to do with the answer.
 */
import { createHash } from 'node:crypto';
import * as v from './validation.js';
import { fuzzyEligible, fuzzyMatch, FUZZY_PREFIX } from './fuzzy.js';
import { tokenize } from './granularity.js';
import type { JsonValue, RecallScoreFloors } from './types.js';

export const FLOOR_KEYS = ['keyword', 'semantic', 'reranker', 'final', 'finalRelative'] as const;

/** Validates a floor set. `keyword` and `final` are unbounded above because BM25
 * and overlap scores are; the others are probabilities or fractions. */
export function parseFloors(value: unknown, label: string): RecallScoreFloors {
  if (value === undefined) return {};
  const input = v.object(value, label);
  v.keys(input, FLOOR_KEYS, label);
  const floors: RecallScoreFloors = {};
  for (const key of FLOOR_KEYS) {
    const floor = input[key];
    if (floor === undefined) continue;
    const bounded = key === 'semantic' || key === 'reranker' || key === 'finalRelative';
    if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || (bounded && floor > 1)) {
      throw new TypeError(`${label}.${key} must be ${bounded ? 'between 0 and 1' : 'a finite number at least 0'}`);
    }
    floors[key] = floor;
  }
  return floors;
}

/** A recall's floors replace the instance defaults key by key. Keys are emitted
 * in a fixed order so the ledger's configuration hash does not depend on how the
 * caller spelled the object. */
export function mergeFloors(defaults: RecallScoreFloors, override: RecallScoreFloors): RecallScoreFloors {
  const merged: RecallScoreFloors = {};
  for (const key of FLOOR_KEYS) {
    const value = override[key] ?? defaults[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export function hasFloors(floors: RecallScoreFloors): boolean {
  return FLOOR_KEYS.some((key) => floors[key] !== undefined);
}

export type NamedMatchMode = false | true | 'auto';

export function parseNamedMatch(value: unknown, label: string): NamedMatchMode | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === false || value === 'auto') return value;
  throw new TypeError(`${label} must be true, false or 'auto'`);
}

/** A validated metadata predicate: each key with the values it may take. */
export type MetadataFilter = { entries: [string, string[]][]; keys: string[]; sha256: string };

/** Validates `RecallInput.metadata`. Keys and values are bound as SQL
 * parameters, never interpolated, so no key spelling can change the statement. */
export function parseMetadataFilter(value: unknown): MetadataFilter | null {
  if (value === undefined) return null;
  const input = v.object(value, 'metadata filter');
  const keys = Object.keys(input).sort();
  if (keys.length > 32) throw new TypeError('At most 32 metadata filters are allowed');
  const entries: [string, string[]][] = keys.map((key) => {
    v.string(key, 'metadata key', 256);
    const raw = input[key];
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.length > 64) throw new TypeError('A metadata filter takes one value or an array of 1-64 values');
    return [key, [...new Set(values.map((item) => v.string(item, 'metadata value', 4096)))].sort()];
  });
  if (!entries.length) return null;
  const sha256 = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { entries, keys, sha256 };
}

/** The SQL half of the metadata predicate, against a `memories m` alias. The same
 * `json_each` form `list()` uses, so a top-level string is matched exactly and a
 * number, boolean or nested value never equals a string. */
export function metadataFilterSql(filter: MetadataFilter | null): { sql: string; parameters: string[] } {
  if (!filter) return { sql: '', parameters: [] };
  const parameters: string[] = [];
  const sql = filter.entries.map(([key, values]) => {
    parameters.push(key, ...values);
    return `AND EXISTS (SELECT 1 FROM json_each(m.data,'$.metadata') j WHERE j.key=? AND j.type='text' AND j.value IN (${values.map(() => '?').join(',')}))`;
  }).join(' ');
  return { sql, parameters };
}

/**
 * Lifecycle prefilter for a CURRENT recall: a superseded record whose direct
 * successor is visible now is not a candidate.
 *
 * This is a strict subset of what the temporal reconstruction (`#at`) already
 * withholds — `#at` also walks the whole successor chain — so it can never
 * withhold a record `#at` would have returned. What it buys is that the decision
 * is made in SQL, before ranking and before the candidate budget: a store full
 * of superseded versions cannot crowd current records out of the budget.
 * A historical recall (explicit `asOf`/`knownAt`) gets no prefilter, because a
 * superseded record is exactly what it may be asking for.
 */
export function lifecycleSql(time: { asOf: string; knownAt: string; historical: boolean }): { sql: string; parameters: string[] } {
  if (time.historical) return { sql: '', parameters: [] };
  return {
    sql: `AND NOT (m.status='superseded' AND json_extract(m.data,'$.updatedAt')<=? AND EXISTS (SELECT 1 FROM memories c WHERE c.workspace_id=m.workspace_id AND c.supersedes=m.id
      AND c.created_at<=? AND coalesce(json_extract(c.data,'$.validFrom'),c.created_at)<=? AND (json_extract(c.data,'$.validUntil') IS NULL OR json_extract(c.data,'$.validUntil')>?)))`,
    parameters: [time.knownAt, time.knownAt, time.asOf, time.asOf],
  };
}

/** Name and query tokens. Underscores separate words here, unlike in the posting
 * tokenizer, so a canonical identifier such as `auth_strategy` reads as the
 * phrase "auth strategy". */
export function nameTokens(text: string): string[] {
  return tokenize(text.replace(/_/g, ' '));
}

/** The names a record declares, or an empty list. Anything that is not a
 * non-empty string is ignored rather than rejected: names are advisory input to
 * recall, not a schema on metadata. */
export function declaredNames(metadata: Record<string, JsonValue> | undefined): string[] {
  const names = metadata?.names;
  if (!Array.isArray(names)) return [];
  return names.filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
}

type Phrase = { id: string; tokens: string[]; key: string };

/** An in-memory index of declared names, rebuilt when the store changes. */
export class NameIndex {
  readonly #byFirst = new Map<string, Phrase[]>();
  /** First tokens grouped by their fuzzy prefix, for typo lookups. */
  readonly #byPrefix = new Map<string, Set<string>>();
  /** Every token of every name, so an exact vocabulary word is never fuzzed. */
  readonly #vocabulary = new Set<string>();
  /** How many records declare each phrase, for weighting shared aliases down. */
  readonly #phraseRecords = new Map<string, Set<string>>();
  readonly #named = new Set<string>();

  add(id: string, names: readonly string[]): void {
    for (const name of names) {
      const tokens = nameTokens(name);
      if (!tokens.length || tokens.length > 16) continue;
      const key = tokens.join(' ');
      const phrase: Phrase = { id, tokens, key };
      const list = this.#byFirst.get(tokens[0]) ?? [];
      if (list.some((existing) => existing.id === id && existing.key === key)) continue;
      list.push(phrase);
      this.#byFirst.set(tokens[0], list);
      const prefix = tokens[0].slice(0, FUZZY_PREFIX);
      const firsts = this.#byPrefix.get(prefix) ?? new Set<string>();
      firsts.add(tokens[0]);
      this.#byPrefix.set(prefix, firsts);
      for (const token of tokens) this.#vocabulary.add(token);
      const records = this.#phraseRecords.get(key) ?? new Set<string>();
      records.add(id);
      this.#phraseRecords.set(key, records);
      this.#named.add(id);
    }
  }

  get size(): number { return this.#named.size; }

  /**
   * Every record with a name occurring in the query as a contiguous token phrase.
   *
   * A record's score is the sum over the distinct phrases it matched of
   * `tokens × idf × (1 for exact, 0.5 for a fuzzy token anywhere in it)`, where
   * the idf is over named records, so an alias two records share counts for less
   * than one only this record carries. Ties keep the order the names occur in
   * the query, which is what gives a compound query's entities a round-robin
   * share of the channel instead of letting one long alias take the head.
   * `allowed` restricts the answer to records the caller may see.
   */
  match(query: string, fuzzy: boolean, allowed?: (id: string) => boolean): { id: string; score: number; position: number; fuzzy: boolean }[] {
    const tokens = nameTokens(query);
    const total = this.#named.size;
    const best = new Map<string, { id: string; score: number; position: number; fuzzy: boolean; phrases: Set<string> }>();
    const same = (queryToken: string, nameToken: string): 0 | 1 | 2 => {
      if (queryToken === nameToken) return 2;
      return fuzzy && !this.#vocabulary.has(queryToken) && fuzzyEligible(queryToken) && fuzzyMatch(queryToken, nameToken) ? 1 : 0;
    };
    for (let position = 0; position < tokens.length; position++) {
      const head = tokens[position];
      const firsts = new Set<string>([head]);
      if (fuzzy && !this.#vocabulary.has(head) && fuzzyEligible(head)) for (const first of this.#byPrefix.get(head.slice(0, FUZZY_PREFIX)) ?? []) firsts.add(first);
      for (const first of firsts) for (const phrase of this.#byFirst.get(first) ?? []) {
        if (position + phrase.tokens.length > tokens.length) continue;
        let exact = true, matched = true;
        for (let offset = 0; offset < phrase.tokens.length; offset++) {
          const result = same(tokens[position + offset], phrase.tokens[offset]);
          if (!result) { matched = false; break; }
          if (result === 1) exact = false;
        }
        if (!matched || (allowed && !allowed(phrase.id))) continue;
        const records = this.#phraseRecords.get(phrase.key)?.size ?? 1;
        const weight = phrase.tokens.length * Math.log1p(total / records) * (exact ? 1 : 0.5);
        const entry = best.get(phrase.id) ?? { id: phrase.id, score: 0, position, fuzzy: !exact, phrases: new Set<string>() };
        if (entry.phrases.has(phrase.key)) continue;
        entry.phrases.add(phrase.key);
        entry.score += weight;
        entry.position = Math.min(entry.position, position);
        entry.fuzzy = entry.fuzzy && !exact;
        best.set(phrase.id, entry);
      }
    }
    return [...best.values()]
      .map(({ id, score, position, fuzzy: viaFuzzy }) => ({ id, score, position, fuzzy: viaFuzzy }))
      .sort((a, b) => b.score - a.score || a.position - b.position || a.id.localeCompare(b.id));
  }
}

/**
 * Picks which query terms the lexical channel scores when a query has more
 * distinct terms than it will use.
 *
 * Taking the first N terms lets a long preamble spend the whole budget on filler
 * and drop the one rare term at the end that names the subject. Keeping the N
 * rarest — by document frequency in scope, ties by first occurrence — keeps the
 * terms that carry the most evidence, and the result keeps query order so the
 * selection is easy to read back. A term no record contains scores nothing, so
 * it ranks after every term that does. Below the cap nothing changes.
 */
export function selectTerms(terms: readonly string[], max: number, frequency: (term: string) => number): string[] {
  if (terms.length <= max) return [...terms];
  const ranked = terms.map((term, index) => { const df = frequency(term); return { term, index, df: df > 0 ? df : Number.MAX_SAFE_INTEGER }; })
    .sort((a, b) => a.df - b.df || a.index - b.index).slice(0, max);
  return ranked.sort((a, b) => a.index - b.index).map((entry) => entry.term);
}

/** The JS half of the metadata predicate, applied again to every hydrated
 * result. Candidates that reach a recall through a derived index were never
 * filtered by the record-level SQL, so the predicate is re-checked on the record
 * itself before it can be returned. */
export function matchesMetadataFilter(metadata: Record<string, JsonValue>, filter: MetadataFilter | null): boolean {
  if (!filter) return true;
  return filter.entries.every(([key, values]) => {
    const value = Object.hasOwn(metadata, key) ? metadata[key] : undefined;
    return typeof value === 'string' && values.includes(value);
  });
}
