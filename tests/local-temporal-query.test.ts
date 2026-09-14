import { describe, expect, it } from 'vitest';
import { parseTemporalQuery, TEMPORAL_ROUTING_MIN_CONFIDENCE } from '../src/local/temporal-query.js';

// A Sunday, deliberately: ISO weeks start on Monday, so a Sunday reference is
// the day most likely to expose an off-by-one in week arithmetic.
const NOW = '2026-03-15T12:30:00.000Z';
const at = (query: string, now: string | Date = NOW) => parseTemporalQuery(query, { now });
const span = (query: string, now: string | Date = NOW) => {
  const parse = at(query, now);
  return parse.window ? [parse.window.from, parse.window.to] : null;
};

describe('temporal query parsing — absolute dates', () => {
  it('reads ISO days, months and slash-separated forms as half-open UTC windows', () => {
    expect(span('what changed on 2026-03-05')).toEqual(['2026-03-05T00:00:00.000Z', '2026-03-06T00:00:00.000Z']);
    expect(span('what changed on 2026/03/05')).toEqual(['2026-03-05T00:00:00.000Z', '2026-03-06T00:00:00.000Z']);
    expect(span('the 2026-03 report')).toEqual(['2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z']);
    expect(span('the 3/2026 report')).toEqual(['2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z']);
  });

  it('reads written dates in either order, with ordinals, abbreviations and stray punctuation', () => {
    const march3 = ['2026-03-03T00:00:00.000Z', '2026-03-04T00:00:00.000Z'];
    for (const query of ['summary for March 3 2026', 'summary for March 3rd, 2026', 'summary for 3 March 2026',
      'summary for 3rd of March, 2026', 'summary for Mar. 3 2026']) expect(span(query)).toEqual(march3);
    expect(span('sept 2025 review')).toEqual(['2025-09-01T00:00:00.000Z', '2025-10-01T00:00:00.000Z']);
    expect(span('1st of April 2024 notes')).toEqual(['2024-04-01T00:00:00.000Z', '2024-04-02T00:00:00.000Z']);
  });

  it('matches month names regardless of case', () => {
    expect(span('MARCH 2026 plan')).toEqual(['2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z']);
    expect(span('march 2026 plan')).toEqual(['2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z']);
  });

  it('resolves a month or day named without a year to its most recent occurrence', () => {
    // June 2026 has not happened yet at NOW, so "in June" means June 2025.
    expect(span('what happened in June')).toEqual(['2025-06-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z']);
    expect(span('what happened in June', '2026-12-31T23:59:59.999Z')).toEqual(['2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z']);
    expect(span('the release on May 8th')).toEqual(['2025-05-08T00:00:00.000Z', '2025-05-09T00:00:00.000Z']);
  });

  it('grades a date carrying its own year above one that has to be guessed', () => {
    expect(at('summary for March 3 2026').confidence).toBeGreaterThan(at('summary for March 3rd').confidence);
    expect(at('what happened in June 2025').confidence).toBeGreaterThan(at('what happened in June').confidence);
    // A bare year is a real constraint but the loosest one, so it sits exactly on
    // the line a caller is told to act at, never above it.
    expect(at('what did we ship in 2025').confidence).toBe(TEMPORAL_ROUTING_MIN_CONFIDENCE);
    expect(span('what did we ship in 2025')).toEqual(['2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });

  it('takes the first date when a query names several', () => {
    expect(span('dec 2024 vs jan 2025')).toEqual(['2024-12-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z']);
  });

  it('reads a counted slice of a named month', () => {
    expect(span('notes from the first week of March 2026')).toEqual(['2026-03-01T00:00:00.000Z', '2026-03-08T00:00:00.000Z']);
    expect(span('notes from the second week of March 2026')).toEqual(['2026-03-08T00:00:00.000Z', '2026-03-15T00:00:00.000Z']);
    // A last week ends with the month, so it is the seven days up to the 1st and
    // not a fourth seven-day block that would stop short of a 31-day month.
    expect(span('notes from the last week of March 2026')).toEqual(['2026-03-25T00:00:00.000Z', '2026-04-01T00:00:00.000Z']);
    expect(span('notes from the last two weeks of August 2023')).toEqual(['2023-08-18T00:00:00.000Z', '2023-09-01T00:00:00.000Z']);
    expect(span('notes from the first half of September 2022')).toEqual(['2022-09-01T00:00:00.000Z', '2022-09-16T00:00:00.000Z']);
    expect(span('notes from the second half of September 2022')).toEqual(['2022-09-16T00:00:00.000Z', '2022-10-01T00:00:00.000Z']);
  });

  it('does not let a trailing span steal a slice of a named month', () => {
    // "the last two weeks" is a rolling span ending today; "the last two weeks of
    // August" is part of August. The first reading starts further left in the
    // sentence, so without the guard it would win on position alone.
    expect(span('where was Dave in the last two weeks')).toEqual(['2026-03-02T00:00:00.000Z', '2026-03-16T00:00:00.000Z']);
    expect(span('where was Dave in the last two weeks of August 2023')).toEqual(['2023-08-18T00:00:00.000Z', '2023-09-01T00:00:00.000Z']);
    expect(at('where was Dave in the last two weeks of August 2023').cleanedQuery).toBe('where was Dave');
  });

  it('inherits the confidence of the month a slice was cut from', () => {
    // The slice is only as certain as the month it names: a year makes it a
    // month-grade reading, a bare month leaves it a guess about which year.
    expect(at('notes from the first week of March 2026').confidence).toBe(0.9);
    expect(at('notes from the first week of March').confidence).toBe(TEMPORAL_ROUTING_MIN_CONFIDENCE);
    expect(at('notes from the first week of March 2026').grain).toBe('week');
  });

  it('reports the grain it actually pinned down', () => {
    expect(at('on 2026-03-05').grain).toBe('day');
    expect(at('in March 2026').grain).toBe('month');
    expect(at('in 2025').grain).toBe('year');
    expect(at('the Atlas quota').grain).toBe('none');
  });
});

describe('temporal query parsing — relative expressions', () => {
  it('resolves day-scale expressions against the injected now', () => {
    expect(span('notes from yesterday')).toEqual(['2026-03-14T00:00:00.000Z', '2026-03-15T00:00:00.000Z']);
    expect(span('last night incident')).toEqual(['2026-03-14T00:00:00.000Z', '2026-03-15T00:00:00.000Z']);
    expect(span('what is on today')).toEqual(['2026-03-15T00:00:00.000Z', '2026-03-16T00:00:00.000Z']);
    expect(span('what is due tomorrow')).toEqual(['2026-03-16T00:00:00.000Z', '2026-03-17T00:00:00.000Z']);
  });

  it('treats a whole ISO week, month and year as calendar periods, not rolling spans', () => {
    // NOW is Sunday 15 March 2026, so the current ISO week began Monday the 9th.
    expect(span('what did I decide about Atlas last week')).toEqual(['2026-03-02T00:00:00.000Z', '2026-03-09T00:00:00.000Z']);
    expect(span('this week')).toEqual(['2026-03-09T00:00:00.000Z', '2026-03-16T00:00:00.000Z']);
    expect(span('next week')).toEqual(['2026-03-16T00:00:00.000Z', '2026-03-23T00:00:00.000Z']);
    expect(span('anything from last month')).toEqual(['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z']);
    expect(span('next month plan')).toEqual(['2026-04-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z']);
    expect(span('last year revenue')).toEqual(['2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
    expect(span('this year revenue')).toEqual(['2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
  });

  it('reads "N units ago" as that period alone, not as everything since', () => {
    expect(span('what happened 3 days ago')).toEqual(['2026-03-12T00:00:00.000Z', '2026-03-13T00:00:00.000Z']);
    expect(span('what happened 10 days ago')).toEqual(['2026-03-05T00:00:00.000Z', '2026-03-06T00:00:00.000Z']);
    expect(span('two months ago')).toEqual(['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
    expect(span('a week ago')).toEqual(['2026-03-02T00:00:00.000Z', '2026-03-09T00:00:00.000Z']);
    expect(span('a year ago')).toEqual(['2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });

  it('reads "in the last N units" as a trailing span that ends today', () => {
    expect(span('decisions in the last 7 days')).toEqual(['2026-03-09T00:00:00.000Z', '2026-03-16T00:00:00.000Z']);
    expect(span('decisions over the past two months')).toEqual(['2026-01-01T00:00:00.000Z', '2026-03-16T00:00:00.000Z']);
    expect(span('decisions in the past 2 years')).toEqual(['2024-03-16T00:00:00.000Z', '2026-03-16T00:00:00.000Z']);
  });

  it('crosses year and leap-day boundaries without drifting', () => {
    expect(span('last month', '2026-01-15T00:00:00.000Z')).toEqual(['2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
    expect(span('last week', '2026-01-01T00:00:00.000Z')).toEqual(['2025-12-22T00:00:00.000Z', '2025-12-29T00:00:00.000Z']);
    expect(span('next month', '2026-12-31T23:59:59.999Z')).toEqual(['2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z']);
    expect(span('yesterday', '2024-03-01T06:00:00.000Z')).toEqual(['2024-02-29T00:00:00.000Z', '2024-03-01T00:00:00.000Z']);
    expect(span('last month', '2024-02-29T00:00:00.000Z')).toEqual(['2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z']);
  });

  it('accepts a Date as readily as an ISO string for now', () => {
    expect(span('yesterday', new Date(NOW))).toEqual(span('yesterday', NOW));
  });
});

describe('temporal query parsing — direction', () => {
  it('turns an exclusionary phrase into a real asOf bound', () => {
    const parse = at('what was the quota before March 2026');
    expect(parse.relation).toBe('before');
    // "Before March" excludes March: the boundary is the first instant of the
    // named period, and the last visible instant is a millisecond earlier.
    expect(parse.asOf).toBe('2026-02-28T23:59:59.999Z');
    expect(at('until yesterday what was true').asOf).toBe('2026-03-13T23:59:59.999Z');
    // ...while "as of March" includes it. One period of difference, so the two
    // readings are kept apart rather than approximated.
    expect(at('the quota as of March 2026').asOf).toBe('2026-03-31T23:59:59.999Z');
    expect(at('the plan as of 2025-06-01').asOf).toBe('2025-06-01T23:59:59.999Z');
    expect(at('the plan no later than March 2026').asOf).toBe('2026-03-31T23:59:59.999Z');
    for (const lead of ['before', 'prior to', 'up to', 'up until', 'until', 'till', 'as of', 'no later than', 'earlier than']) {
      expect(at(`quota ${lead} 2025-06-01`).relation).toBe('before');
    }
  });

  it('never sets knownAt, because a date in a question is about the world', () => {
    // Setting transaction time here would hide every memory written after the
    // named date, including one written this morning about last year.
    for (const query of ['what was the quota before March 2026', 'the plan as of 2025-06-01',
      'changes since June 2025', 'what happened in June 2023', 'last week']) {
      expect(at(query).knownAt).toBeUndefined();
    }
  });

  it('leaves the bounds alone for a scoping phrase, which narrows relevance and not visibility', () => {
    const parse = at('what did I decide about Atlas last week');
    expect(parse.relation).toBe('at');
    expect(parse.asOf).toBeUndefined();
    expect(parse.knownAt).toBeUndefined();
    expect(parse.window).toBeDefined();
  });

  it('opens the window forward, including or excluding the date it names', () => {
    const parse = at('changes since June 2025');
    expect(parse.relation).toBe('after');
    // "Since June" includes June; "after June" starts in July.
    expect(parse.window?.from).toBe('2025-06-01T00:00:00.000Z');
    expect(at('changes after June 2025').window?.from).toBe('2025-07-01T00:00:00.000Z');
    expect(at('changes no earlier than June 2025').window?.from).toBe('2025-06-01T00:00:00.000Z');
    expect(new Date(parse.window!.to).getUTCFullYear()).toBe(9999);
    expect(parse.asOf).toBeUndefined();
    for (const lead of ['after', 'since', 'later than', 'no earlier than', 'onwards from']) {
      expect(at(`changes ${lead} 2025-06-01`).relation).toBe('after');
    }
  });

  it('spans both endpoints of a "between" phrase', () => {
    expect(span('notes between March 2025 and June 2025')).toEqual(['2025-03-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z']);
    expect(at('notes between March 2025 and June 2025').relation).toBe('between');
    expect(span('between 2025-01-01 and 2025-01-31')).toEqual(['2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z']);
  });

  it('claims only the date a direction word actually introduces', () => {
    // "since" here governs a migration, not a month; the month is still scoping.
    const parse = at('since the Atlas migration, in June 2023 what changed');
    expect(parse.relation).toBe('at');
    expect(parse.matched[0]?.text).toBe('in June 2023');
    expect(parse.asOf).toBeUndefined();
  });

  it('falls back to a plain reading when "between" has no second date', () => {
    expect(at('what happened between the two releases').confidence).toBe(0);
    expect(at('what shipped between releases in June 2025').relation).toBe('at');
  });
});

describe('temporal query parsing — declining to narrow', () => {
  const declines = (query: string) => {
    const parse = at(query);
    expect(parse.confidence).toBe(0);
    expect(parse.confidence).toBeLessThan(TEMPORAL_ROUTING_MIN_CONFIDENCE);
    expect(parse.window).toBeUndefined();
    expect(parse.asOf).toBeUndefined();
    expect(parse.knownAt).toBeUndefined();
    expect(parse.relation).toBe('none');
    expect(parse.grain).toBe('none');
    expect(parse.matched).toEqual([]);
    expect(parse.cleanedQuery).toBe(query.trim());
  };

  it('returns no narrowing for a query with no time expression at all', () => {
    for (const query of ['what is the Atlas quota', 'notes from Atlas', 'who approved the catalogue',
      'recently discussed', 'q3 revenue', '']) declines(query);
  });

  it('refuses an ambiguous numeric date rather than picking a convention', () => {
    // 2/3/2026 is 2 March to half the world and 3 February to the other half.
    for (const query of ['meeting on 2/3/2026', 'meeting on 02/03/26', 'meeting on 2.3.2026']) declines(query);
  });

  it('refuses an impossible date instead of falling back to a coarser reading', () => {
    for (const query of ['February 31 2026 retrospective', 'notes for 2026-13-01', 'notes for 2025-02-30']) declines(query);
  });

  it('does not mistake decades, versions or identifiers for years', () => {
    for (const query of ['the 2020s archive', 'v2026 spec', 'ticket 1234 status', 'port 8080 config',
      'released 999999 years ago', 'in 2100']) declines(query);
  });

  it('declines on input too large to be a real question', () => {
    const parse = at(`${'x'.repeat(5_000)} last week`);
    expect(parse.confidence).toBe(0);
    expect(parse.window).toBeUndefined();
  });
});

describe('temporal query parsing — the cleaned query', () => {
  it('removes the time expression and the preposition that introduced it', () => {
    expect(at('what did I decide about Atlas last week').cleanedQuery).toBe('what did I decide about Atlas');
    expect(at('what was the quota before March 2026').cleanedQuery).toBe('what was the quota');
    expect(at('the release on May 8th').cleanedQuery).toBe('the release');
    expect(at('decisions in the last 7 days').cleanedQuery).toBe('decisions');
  });

  it('does not strand the preposition left behind by a trailing date', () => {
    expect(at('notes from yesterday').cleanedQuery).toBe('notes');
    expect(at('summary for March 3 2026').cleanedQuery).toBe('summary');
    // ...but a preposition that is not introducing a date keeps its words.
    expect(at('notes from Atlas').cleanedQuery).toBe('notes from Atlas');
  });

  it('closes the hole left mid-query without gluing words together', () => {
    expect(at('since the Atlas migration, in June 2023 what changed').cleanedQuery).toBe('since the Atlas migration, what changed');
    expect(at('the 3/2026 report').cleanedQuery).toBe('the report');
  });

  it('never returns an empty query, even when the query was nothing but a date', () => {
    for (const query of ['last week', 'in 2025', 'up to 2024-12-31', 'between 2025-01-01 and 2025-01-31']) {
      expect(at(query).cleanedQuery).toBe(query);
    }
  });

  it('returns the query unchanged when nothing was parsed', () => {
    expect(at('what is the Atlas quota').cleanedQuery).toBe('what is the Atlas quota');
  });
});

describe('temporal query parsing — contract', () => {
  it('is deterministic across repeated calls, including stateful global patterns', () => {
    const once = at('in June 2023 and March 2024');
    for (let i = 0; i < 5; i++) expect(at('in June 2023 and March 2024')).toEqual(once);
    // Interleaving a different query must not leave regex state behind.
    at('what changed on 2026-03-05');
    expect(at('in June 2023 and March 2024')).toEqual(once);
  });

  it('defaults now to the current time without reading it for absolute dates', () => {
    expect(parseTemporalQuery('what changed on 2026-03-05').window)
      .toEqual({ from: '2026-03-05T00:00:00.000Z', to: '2026-03-06T00:00:00.000Z' });
    expect(parseTemporalQuery('last week').window).toBeDefined();
    expect(parseTemporalQuery('what is the Atlas quota').confidence).toBe(0);
  });

  it('reports the span it matched so a routing decision can be audited', () => {
    const query = 'what did I decide about Atlas last week';
    const { matched } = at(query);
    expect(matched).toHaveLength(1);
    expect(query.slice(matched[0]!.start, matched[0]!.end)).toBe(matched[0]!.text);
    expect(matched[0]!.text).toBe('last week');
  });

  it('rejects a non-string query and an unreadable now', () => {
    for (const bad of [null, 42, undefined, {}]) expect(() => parseTemporalQuery(bad as unknown as string)).toThrow(TypeError);
    expect(() => parseTemporalQuery('last week', { now: 'not-a-date' })).toThrow(/now must be a valid date/);
    expect(() => parseTemporalQuery('last week', [] as unknown as Record<string, never>)).toThrow(TypeError);
  });

  it('produces windows that are always ordered and half-open', () => {
    for (const query of ['last week', 'in June 2025', 'on 2026-03-05', 'since June 2025', 'before March 2026',
      'between March 2025 and June 2025', 'two months ago', 'in the last 7 days', 'in 2025']) {
      const { window } = at(query);
      expect(window).toBeDefined();
      expect(new Date(window!.from).getTime()).toBeLessThan(new Date(window!.to).getTime());
      expect(window!.from).toBe(new Date(window!.from).toISOString());
      expect(window!.to).toBe(new Date(window!.to).toISOString());
    }
  });
});
