/**
 * Deterministic temporal parsing of a retrieval query.
 *
 * A question like "what did I decide about Atlas last week" or "before March
 * 2026" carries a time constraint that retrieval cannot currently see: the
 * ranking channels match words, and a date in the query is just more words. This
 * module turns that phrase into a machine-usable constraint so recall can narrow
 * to the right slice of history.
 *
 * Three properties are deliberate and load-bearing:
 *
 * - **Offline and deterministic.** Regular expressions and UTC calendar
 *   arithmetic; no model, no network, no locale database. The same query with the
 *   same `now` always produces the same parse, which is what lets a routing
 *   decision be replayed from a ledger entry.
 * - **`now` is injectable.** Relative expressions are meaningless without a
 *   reference instant, and a parser that reads the wall clock cannot be tested.
 * - **Silence is a valid answer.** A query with no time expression, or with an
 *   ambiguous or impossible one, returns `confidence: 0` and no window. Guessing
 *   is more damaging than declining, because a wrong window hides the very
 *   evidence the caller asked for.
 *
 * Everything is computed in UTC. Day, month and year boundaries are UTC
 * midnights, and every window is half-open: `from` inclusive, `to` exclusive.
 */

/** Half-open instant range: `from` inclusive, `to` exclusive, both ISO UTC. */
export interface TemporalWindow {
  from: string;
  to: string;
}

/** How the parsed phrase constrains time. */
export type TemporalRelation = 'none' | 'at' | 'before' | 'after' | 'between';

/** The calendar precision the phrase actually pinned down. */
export type TemporalGrain = 'none' | 'day' | 'month' | 'year';

/** The literal span that produced the constraint, so a routing decision can be audited. */
export interface TemporalMatch {
  text: string;
  start: number;
  end: number;
}

export interface TemporalQueryParse {
  /**
   * Real-world upper bound, set only for genuinely exclusionary phrases
   * ("before March 2026", "as of 2025-01-01"). A scoping phrase such as "in June
   * 2023" reports a `window` and leaves this undefined: it says which slice is
   * most relevant, not that later evidence must become invisible.
   */
  asOf?: string;
  /**
   * Transaction-time upper bound — when the system LEARNED something, as opposed
   * to when it was true. Never set by this parser, deliberately.
   *
   * A date in a question is almost always about the world: "what was the quota
   * before March 2026" asks what was true then, not what had been recorded by
   * then. Answering it with a transaction-time bound would hide every memory
   * written after March 2026, which is nearly all of them, including the ones
   * written this morning about last year. The field stays in the shape because a
   * caller may set it, and because an explicitly epistemic phrase ("as far as we
   * knew on Tuesday") could one day fill it; no phrase read here makes that claim.
   */
  knownAt?: string;
  /** The slice the phrase points at. Present whenever anything was parsed. */
  window?: TemporalWindow;
  /** The query with the time expression removed, for the ranking channels. Never empty. */
  cleanedQuery: string;
  /** 0 when nothing was parsed, otherwise how far the phrase can be trusted. */
  confidence: number;
  relation: TemporalRelation;
  grain: TemporalGrain;
  /** Empty when nothing was parsed. */
  matched: TemporalMatch[];
}

export interface TemporalQueryOptions {
  /** Reference instant for relative expressions. Defaults to the current time. */
  now?: Date | string;
}

/**
 * The confidence at or above which a caller should act on a parse. A month or a
 * year named without further qualification sits exactly on this line: it is a
 * real constraint, but an easy one to mean loosely. Absolute dates sit well above
 * it, and anything the parser declines to read reports 0 and falls below it.
 */
export const TEMPORAL_ROUTING_MIN_CONFIDENCE = 0.6;

/** Furthest instant the parser will name, standing in for "no upper bound". */
const FAR_FUTURE = Date.UTC(9999, 11, 31);
const DAY_MS = 86_400_000;
/** Bounds "99999999 years ago" so a pathological query cannot produce a nonsense instant. */
const MAX_UNITS = 1000;

const CONFIDENCE = Object.freeze({ day: 0.95, month: 0.9, relative: 0.85, unqualified: 0.6 });

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sept: 9, sep: 9, oct: 10, nov: 11, dec: 12,
});
// Longest first, so "sept" is never read as "sep" with a stray "t".
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const UNITS: Readonly<Record<string, 'day' | 'week' | 'month' | 'year'>> = Object.freeze({
  day: 'day', days: 'day', week: 'week', weeks: 'week',
  month: 'month', months: 'month', year: 'year', years: 'year',
});
const WORD_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, a: 1, an: 1,
});
const COUNTS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';

const iso = (at: number): string => new Date(at).toISOString();
const utc = (year: number, month: number, day: number): number => Date.UTC(year, month - 1, day);
const startOfDay = (at: number): number => Math.floor(at / DAY_MS) * DAY_MS;
/** ISO weeks start on Monday; `getUTCDay()` counts Sunday as 0. */
const startOfWeek = (at: number): number => startOfDay(at) - ((new Date(at).getUTCDay() + 6) % 7) * DAY_MS;
const startOfMonth = (at: number): number => utc(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() + 1, 1);
const startOfYear = (at: number): number => utc(new Date(at).getUTCFullYear(), 1, 1);
const addMonths = (at: number, count: number): number => {
  const date = new Date(at);
  const month = date.getUTCMonth() + count;
  return utc(date.getUTCFullYear() + Math.floor(month / 12), ((month % 12) + 12) % 12 + 1, 1);
};

/** True only for a real calendar day, so 31 February is rejected rather than rolled forward. */
function validDay(year: number, month: number, day: number): boolean {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const at = new Date(utc(year, month, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() + 1 === month && at.getUTCDate() === day;
}

interface Anchor { from: number; to: number; grain: TemporalGrain; confidence: number }

const dayAnchor = (year: number, month: number, day: number, confidence: number = CONFIDENCE.day): Anchor | null =>
  validDay(year, month, day)
    ? { from: utc(year, month, day), to: utc(year, month, day) + DAY_MS, grain: 'day', confidence }
    : null;
const monthAnchor = (year: number, month: number, confidence: number = CONFIDENCE.month): Anchor | null =>
  month >= 1 && month <= 12 && year >= 1000 && year <= 9999
    ? { from: utc(year, month, 1), to: addMonths(utc(year, month, 1), 1), grain: 'month', confidence }
    : null;
const yearAnchor = (year: number): Anchor | null =>
  year >= 1000 && year <= 9999
    ? { from: utc(year, 1, 1), to: utc(year + 1, 1, 1), grain: 'year', confidence: CONFIDENCE.unqualified }
    : null;

/** The most recent occurrence of a month at or before `now`. */
function recentMonth(month: number, now: number): Anchor | null {
  const here = new Date(now);
  return monthAnchor(here.getUTCFullYear() - (month > here.getUTCMonth() + 1 ? 1 : 0), month, CONFIDENCE.unqualified);
}
/** The most recent occurrence of a day-of-month at or before `now`. */
function recentDay(month: number, day: number, now: number): Anchor | null {
  const year = new Date(now).getUTCFullYear();
  return dayAnchor(utc(year, month, day) > now ? year - 1 : year, month, day, CONFIDENCE.unqualified);
}

function amount(token: string): number | null {
  const value = WORD_NUMBERS[token.toLowerCase()] ?? Number(token);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_UNITS ? value : null;
}
/** A trailing span ending today: "in the last 3 weeks". */
function trailing(count: string, unitToken: string, now: number): Anchor | null {
  const n = amount(count), unit = UNITS[unitToken.toLowerCase()];
  if (n === null || !unit) return null;
  const to = startOfDay(now) + DAY_MS;
  const from = unit === 'day' ? to - n * DAY_MS
    : unit === 'week' ? to - n * 7 * DAY_MS
    : unit === 'month' ? addMonths(to, -n)
    : utc(new Date(to).getUTCFullYear() - n, new Date(to).getUTCMonth() + 1, new Date(to).getUTCDate());
  return { from, to, grain: unit === 'year' ? 'year' : unit === 'month' ? 'month' : 'day', confidence: CONFIDENCE.relative };
}
/** The named period itself, not everything since it: "3 days ago" is one day. */
function ago(count: string, unitToken: string, now: number): Anchor | null {
  const n = amount(count), unit = UNITS[unitToken.toLowerCase()];
  if (n === null || !unit) return null;
  if (unit === 'day') { const from = startOfDay(now) - n * DAY_MS; return { from, to: from + DAY_MS, grain: 'day', confidence: CONFIDENCE.relative }; }
  if (unit === 'week') { const from = startOfWeek(now) - n * 7 * DAY_MS; return { from, to: from + 7 * DAY_MS, grain: 'day', confidence: CONFIDENCE.relative }; }
  if (unit === 'month') { const from = addMonths(startOfMonth(now), -n); return { from, to: addMonths(from, 1), grain: 'month', confidence: CONFIDENCE.relative }; }
  const year = new Date(now).getUTCFullYear() - n;
  return { from: utc(year, 1, 1), to: utc(year + 1, 1, 1), grain: 'year', confidence: CONFIDENCE.relative };
}

/**
 * A date form: a pattern, a reader, and whether it names a specific calendar day.
 *
 * Order matters. The longest, most specific form is tried first, or "8 May 2023"
 * is read as the bare month "May" with a stray number beside it. `M/D/YYYY` is
 * absent on purpose — see `AMBIGUOUS_NUMERIC`.
 *
 * `day: true` marks the forms that name one calendar day. When such a form
 * matches textually but names an impossible date, the whole parse fails rather
 * than falling back to a coarser reading of the same words: someone who wrote
 * "February 31 2026" meant a day, and answering them with the year 2026 is worse
 * than admitting the phrase could not be read.
 */
interface Form { expression: RegExp; read: (match: RegExpExecArray, now: number) => Anchor | null; day?: boolean }

const FORMS: readonly Form[] = [
  // 2026-03-05, 2026/03/05
  { day: true, expression: /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/gi, read: m => dayAnchor(+m[1], +m[2], +m[3]) },
  // 3 March 2026, 3rd of March, 2026
  { day: true, expression: new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\.?\\s*,?\\s*(\\d{4})`, 'gi'), read: m => dayAnchor(+m[3], MONTHS[m[2].toLowerCase()], +m[1]) },
  // March 3 2026, March 3rd, 2026
  { day: true, expression: new RegExp(`(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})`, 'gi'), read: m => dayAnchor(+m[3], MONTHS[m[1].toLowerCase()], +m[2]) },
  // March 2026
  { expression: new RegExp(`(${MONTH_NAMES})\\.?\\s*,?\\s+(\\d{4})`, 'gi'), read: m => monthAnchor(+m[2], MONTHS[m[1].toLowerCase()]) },
  // 2026-03
  { expression: /(\d{4})-(\d{1,2})(?![-/\d])/gi, read: m => monthAnchor(+m[1], +m[2]) },
  // 3/2026
  { expression: /(\d{1,2})\/(\d{4})/gi, read: m => monthAnchor(+m[2], +m[1]) },
  // 3 March, March 3rd — no year, so the most recent occurrence at or before now.
  { day: true, expression: new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\.?(?!\\s*,?\\s*\\d)`, 'gi'), read: (m, now) => recentDay(MONTHS[m[2].toLowerCase()], +m[1], now) },
  { day: true, expression: new RegExp(`(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\s*,?\\s*\\d)`, 'gi'), read: (m, now) => recentDay(MONTHS[m[1].toLowerCase()], +m[2], now) },
  // March, with no year and no day.
  { expression: new RegExp(`(${MONTH_NAMES})\\b(?!\\.?\\s*,?\\s*\\d)`, 'gi'), read: (m, now) => recentMonth(MONTHS[m[1].toLowerCase()], now) },

  // "Last week" is the previous whole ISO week; "in the last 7 days" is the
  // trailing seven days. They are different questions and stay separate.
  { expression: /yesterday|last night/gi, read: (_m, now) => ({ from: startOfDay(now) - DAY_MS, to: startOfDay(now), grain: 'day', confidence: CONFIDENCE.relative }) },
  { expression: /today/gi, read: (_m, now) => ({ from: startOfDay(now), to: startOfDay(now) + DAY_MS, grain: 'day', confidence: CONFIDENCE.relative }) },
  { expression: /tomorrow/gi, read: (_m, now) => ({ from: startOfDay(now) + DAY_MS, to: startOfDay(now) + 2 * DAY_MS, grain: 'day', confidence: CONFIDENCE.relative }) },
  { expression: new RegExp(`(?:in|over|during|within|for)?\\s*the\\s+(?:last|past|previous|preceding|trailing)\\s+(\\d{1,4}|${COUNTS})\\s+(days|weeks|months|years)`, 'gi'), read: (m, now) => trailing(m[1], m[2], now) },
  { expression: new RegExp(`(\\d{1,4}|${COUNTS}|an?)\\s+(days?|weeks?|months?|years?)\\s+ago`, 'gi'), read: (m, now) => ago(m[1], m[2], now) },
  { expression: /(?:last|previous|past)\s+week/gi, read: (_m, now) => ({ from: startOfWeek(now) - 7 * DAY_MS, to: startOfWeek(now), grain: 'day', confidence: CONFIDENCE.relative }) },
  { expression: /(?:last|previous|past)\s+month/gi, read: (_m, now) => ({ from: addMonths(startOfMonth(now), -1), to: startOfMonth(now), grain: 'month', confidence: CONFIDENCE.relative }) },
  { expression: /(?:last|previous|past)\s+year/gi, read: (_m, now) => ({ from: utc(new Date(now).getUTCFullYear() - 1, 1, 1), to: startOfYear(now), grain: 'year', confidence: CONFIDENCE.relative }) },
  { expression: /this\s+week/gi, read: (_m, now) => ({ from: startOfWeek(now), to: startOfWeek(now) + 7 * DAY_MS, grain: 'day', confidence: CONFIDENCE.relative }) },
  { expression: /this\s+month/gi, read: (_m, now) => ({ from: startOfMonth(now), to: addMonths(startOfMonth(now), 1), grain: 'month', confidence: CONFIDENCE.relative }) },
  { expression: /this\s+year/gi, read: (_m, now) => ({ from: startOfYear(now), to: utc(new Date(now).getUTCFullYear() + 1, 1, 1), grain: 'year', confidence: CONFIDENCE.relative }) },
  { expression: /next\s+week/gi, read: (_m, now) => ({ from: startOfWeek(now) + 7 * DAY_MS, to: startOfWeek(now) + 14 * DAY_MS, grain: 'day', confidence: CONFIDENCE.relative }) },
  { expression: /next\s+month/gi, read: (_m, now) => ({ from: addMonths(startOfMonth(now), 1), to: addMonths(startOfMonth(now), 2), grain: 'month', confidence: CONFIDENCE.relative }) },
  { expression: /next\s+year/gi, read: (_m, now) => ({ from: utc(new Date(now).getUTCFullYear() + 1, 1, 1), to: utc(new Date(now).getUTCFullYear() + 2, 1, 1), grain: 'year', confidence: CONFIDENCE.relative }) },

  // A bare year is last: every form above that carries a year would otherwise
  // lose its day and month to it.
  // Word-bounded, so "the 2020s" is a decade and "v2026" is a version, not years;
  // and range-bounded, so "ticket 1234" is an identifier and not the year 1234.
  { expression: /\b(19\d{2}|20\d{2})\b(?![-/\d])/g, read: m => yearAnchor(+m[1]) },
];

/** `2/3/2026` is 2 March to half the world and 3 February to the other half. */
const AMBIGUOUS_NUMERIC = /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/;
/**
 * The words that put a date in a direction, and whether they include the date
 * they name.
 *
 * "Before March" excludes March; "as of March" includes it. Getting that
 * boundary wrong silently shifts every answer by one whole period, so the two
 * readings are separate entries rather than one approximate rule. "No earlier
 * than" ends in "earlier than" and "no later than" ends in "later than", so each
 * negated form carries a lookbehind to out-match the phrase it contains.
 */
const DIRECTIONS: readonly { relation: 'before' | 'after'; inclusive: boolean; pattern: string }[] = [
  { relation: 'before', inclusive: true, pattern: '(?:as of|up to|no later than|through)' },
  { relation: 'before', inclusive: false, pattern: '(?:before|prior to|(?<!\\bno\\s)earlier than|up until|until|till)' },
  { relation: 'after', inclusive: true, pattern: '(?:since|no earlier than|onwards? from|starting(?: from)?)' },
  { relation: 'after', inclusive: false, pattern: '(?:after|(?<!\\bno\\s)later than)' },
];
const AT = '(?:in|on|at|during|throughout|within|back in|over)';
const DIRECTED = DIRECTIONS.map(direction => ({ ...direction, expression: new RegExp(`\\b${direction.pattern}\\s*$`, 'i') }));
const ANY_DIRECTION = DIRECTIONS.map(direction => direction.pattern).join('|');
const LEADS = Object.freeze({
  at: new RegExp(`\\b${AT}\\s*$`, 'i'),
  directed: new RegExp(`\\b(?:${ANY_DIRECTION})\\s*$`, 'i'),
  // Removing a trailing date can strand the preposition that introduced it
  // ("notes from yesterday" -> "notes from"); only a trailing one is stripped, so
  // "notes from Atlas" keeps its words.
  dangling: new RegExp(`\\b(?:${ANY_DIRECTION}|${AT}|from|for|of|around|near)\\s*$`, 'i'),
});
const BETWEEN = /\bbetween\b/i;
const JOINER = /\b(?:and|to|through|until)\b/i;
/** The longest lead phrase is "no earlier than"; a little slack costs nothing. */
const LEAD_WINDOW = 24;

interface Found { anchor: Anchor; start: number; end: number }

/**
 * The earliest readable date in `text` at or after `offset`.
 *
 * `impossible` reports that a day-naming form matched but named a date that does
 * not exist, which the caller treats as a parse failure.
 */
function findDate(text: string, offset: number, now: number): { found: Found | null; impossible: boolean } {
  let found: Found | null = null;
  let impossible = false;
  for (const form of FORMS) {
    form.expression.lastIndex = offset;
    for (let match = form.expression.exec(text); match; match = form.expression.exec(text)) {
      const anchor = form.read(match, now);
      if (!anchor) {
        if (form.day) impossible = true;
        continue;
      }
      // Earliest wins; on a tie the longer, more specific reading wins.
      if (!found || match.index < found.start || (match.index === found.start && match[0].length > found.end - found.start)) {
        found = { anchor, start: match.index, end: match.index + match[0].length };
      }
      break;
    }
  }
  return { found, impossible };
}

/** Removes the matched spans, closes the hole, and never yields an empty query. */
function clean(query: string, spans: readonly { start: number; end: number }[]): string {
  let text = query;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) text = `${text.slice(0, span.start)} ${text.slice(span.end)}`;
  const stripped = text
    .replace(LEADS.dangling, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.?!;:])/g, '$1')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
    .trim();
  return stripped || query.trim();
}

const nothing = (query: string): TemporalQueryParse =>
  ({ cleanedQuery: query.trim() || query, confidence: 0, relation: 'none', grain: 'none', matched: [] });

/**
 * Parses the time expression in `query`, if there is one.
 *
 * Returns `confidence: 0` and no window when the query carries no time
 * expression, when the only date-like token is ambiguous (`2/3/2026`), or when a
 * phrase names an impossible date (31 February). A caller should narrow only at
 * or above `TEMPORAL_ROUTING_MIN_CONFIDENCE`.
 *
 * `asOf` is set only for exclusionary phrases, where the caller is saying later
 * evidence must not be visible. A scoping phrase reports its `window` and leaves
 * the bound alone, because "in June" asks which slice is most relevant, not that
 * July must be hidden. `knownAt` is never set — see its doc for why.
 *
 * @throws TypeError if `query` is not a string or `now` is not a valid date.
 */
export function parseTemporalQuery(query: string, options: TemporalQueryOptions = {}): TemporalQueryParse {
  if (typeof query !== 'string') throw new TypeError('query must be a string');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('temporal options must be a plain object');
  const reference = options.now === undefined ? new Date() : new Date(options.now);
  if (!Number.isFinite(reference.getTime())) throw new TypeError('now must be a valid date');
  const now = reference.getTime();
  // Recall already bounds query text; this only keeps a pathological input cheap.
  if (!query.trim() || query.length > 4_096) return nothing(query);
  if (AMBIGUOUS_NUMERIC.test(query)) return nothing(query);

  const between = BETWEEN.exec(query);
  if (between) {
    const first = findDate(query, between.index, now);
    const joiner = first.found ? JOINER.exec(query.slice(first.found.end)) : null;
    const second = first.found && joiner ? findDate(query, first.found.end + joiner.index + joiner[0].length, now) : null;
    if (first.found && second?.found && second.found.anchor.to > first.found.anchor.from) {
      const span = { start: between.index, end: second.found.end };
      return {
        window: { from: iso(first.found.anchor.from), to: iso(second.found.anchor.to) },
        cleanedQuery: clean(query, [span]),
        confidence: Math.min(first.found.anchor.confidence, second.found.anchor.confidence),
        relation: 'between',
        grain: first.found.anchor.grain,
        matched: [{ text: query.slice(span.start, span.end), start: span.start, end: span.end }],
      };
    }
  }

  const { found, impossible } = findDate(query, 0, now);
  if (impossible || !found) return nothing(query);

  // The direction is decided by the words immediately before the date, not by
  // scanning the whole query: "since" in "since the Atlas migration, in June
  // 2023" must not claim a date it does not introduce.
  const lead = query.slice(Math.max(0, found.start - LEAD_WINDOW), found.start);
  const directed = DIRECTED.find(direction => direction.expression.test(lead));
  const prefix = (directed ? LEADS.directed : LEADS.at).exec(lead);
  const start = prefix ? found.start - (lead.length - prefix.index) : found.start;
  const base = {
    cleanedQuery: clean(query, [{ start, end: found.end }]),
    confidence: found.anchor.confidence,
    grain: found.anchor.grain,
    matched: [{ text: query.slice(start, found.end), start, end: found.end }],
  };
  if (!directed) return { ...base, relation: 'at', window: { from: iso(found.anchor.from), to: iso(found.anchor.to) } };

  if (directed.relation === 'before') {
    // The boundary is the first excluded instant, so the last visible one is a
    // millisecond earlier. `knownAt` is deliberately left open — see its doc.
    const boundary = directed.inclusive ? found.anchor.to : found.anchor.from;
    return { ...base, relation: 'before', asOf: iso(boundary - 1), window: { from: iso(0), to: iso(boundary) } };
  }
  return { ...base, relation: 'after', window: { from: iso(directed.inclusive ? found.anchor.from : found.anchor.to), to: iso(FAR_FUTURE) } };
}
