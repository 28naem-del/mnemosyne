/**
 * A seeded bitemporal timeline corpus, and the ground truth for it.
 *
 * The point of this fixture is that the expected answer at a cut point is
 * computed from the PLAN — a plain array of facts with validity intervals and
 * the date each was learned — and never from the store. So "the as-of answer
 * matches ground truth" is a real comparison and not the implementation
 * agreeing with itself.
 *
 * Structure it deliberately contains, because each exercises a different branch
 * of `LocalMemory.#at()`:
 *  - facts with disjoint real-world validity intervals sharing one `key`
 *  - knowledge that arrived LATE (`createdAt` well after `validFrom`), which is
 *    the case where `asOf` and `knownAt` genuinely disagree
 *  - `correct()` chains, so the superseded-lineage branch is walked
 *  - records with no validity window at all (transaction time only)
 *  - untrusted records, which are part of the state and must be in the hash
 */
import type { LocalMemory } from '../../src/local/index.js';

const DAY = 86_400_000;
export const TIMELINE_EPOCH = Date.UTC(2024, 0, 1);

/** mulberry32 — small, fast, and identical on every engine. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function iso(millis: number): string {
  return new Date(millis).toISOString();
}

export interface PlannedFactVersion {
  /** Real-world validity, half-open: [validFrom, validUntil). */
  validFrom: number;
  validUntil?: number;
  /** Transaction time: when the system learned it. Always >= validFrom here. */
  knownFrom: number;
  value: string;
  text: string;
}

export interface PlannedFact {
  key: string;
  entity: string;
  versions: PlannedFactVersion[];
}

export interface TimelinePlan {
  facts: PlannedFact[];
  /** Records with no validity window; transaction time only. */
  plain: { text: string; createdAt: number }[];
  /** `correct()` chains: original, then the correction. */
  corrections: { text: string; createdAt: number; correctedText: string; correctedAt: number }[];
  untrusted: { text: string; createdAt: number }[];
  /** Every distinct instant the plan can change at, ascending. */
  boundaries: number[];
  bounds: { start: number; end: number };
}

const CITIES = ['Lisbon', 'Dubai', 'Reykjavik', 'Osaka', 'Nairobi', 'Montreal', 'Valencia', 'Tallinn'];
const TOPICS = ['deployment window', 'retention policy', 'on-call rotation', 'billing cycle', 'index rebuild'];

/**
 * @param entities how many keyed facts; each gets `versions` disjoint intervals.
 * The default sizes the corpus for a 1000-cut-point replay inside the unit-test
 * budget; the harness passes a larger one.
 */
export function buildTimelinePlan(seed = 20260915, entities = 18, versions = 4): TimelinePlan {
  const random = seededRandom(seed);
  const facts: PlannedFact[] = [];
  for (let entity = 0; entity < entities; entity++) {
    const name = `person-${String(entity).padStart(3, '0')}`;
    const list: PlannedFactVersion[] = [];
    // Each entity's changes start on its own offset so boundaries interleave.
    let cursor = TIMELINE_EPOCH + Math.floor(random() * 30) * DAY;
    for (let version = 0; version < versions; version++) {
      const validFrom = cursor;
      const span = (60 + Math.floor(random() * 120)) * DAY;
      cursor = validFrom + span;
      const value = CITIES[(entity + version) % CITIES.length];
      list.push({
        validFrom,
        ...(version === versions - 1 ? {} : { validUntil: cursor }),
        // Knowledge lags reality by 0, 3 or 17 days — the late-arrival case.
        knownFrom: validFrom + [0, 3, 17][Math.floor(random() * 3)] * DAY,
        value,
        text: `${name} lives in ${value}`,
      });
    }
    facts.push({ key: `home:${name}`, entity: name, versions: list });
  }

  const plain: TimelinePlan['plain'] = [];
  for (let index = 0; index < 12; index++) {
    plain.push({
      text: `note-${String(index).padStart(3, '0')}: the ${TOPICS[index % TOPICS.length]} was reviewed`,
      createdAt: TIMELINE_EPOCH + Math.floor(random() * 700) * DAY,
    });
  }

  const corrections: TimelinePlan['corrections'] = [];
  for (let index = 0; index < 6; index++) {
    const createdAt = TIMELINE_EPOCH + Math.floor(random() * 400) * DAY;
    corrections.push({
      text: `policy-${index}: the ${TOPICS[index % TOPICS.length]} is quarterly`,
      createdAt,
      correctedText: `policy-${index}: the ${TOPICS[index % TOPICS.length]} is monthly`,
      correctedAt: createdAt + (20 + Math.floor(random() * 200)) * DAY,
    });
  }

  const untrusted: TimelinePlan['untrusted'] = [];
  for (let index = 0; index < 4; index++) {
    untrusted.push({
      text: `unverified-${index}: an unattributed claim about the ${TOPICS[index % TOPICS.length]}`,
      createdAt: TIMELINE_EPOCH + Math.floor(random() * 700) * DAY,
    });
  }

  const boundaries = new Set<number>();
  for (const fact of facts) {
    for (const version of fact.versions) {
      boundaries.add(version.validFrom);
      boundaries.add(version.knownFrom);
      if (version.validUntil !== undefined) boundaries.add(version.validUntil);
    }
  }
  for (const note of plain) boundaries.add(note.createdAt);
  for (const entry of corrections) { boundaries.add(entry.createdAt); boundaries.add(entry.correctedAt); }
  for (const entry of untrusted) boundaries.add(entry.createdAt);

  const ordered = [...boundaries].sort((a, b) => a - b);
  return {
    facts, plain, corrections, untrusted, boundaries: ordered,
    bounds: { start: ordered[0] - 30 * DAY, end: ordered[ordered.length - 1] + 120 * DAY },
  };
}

/**
 * GROUND TRUTH. What the plan says is true at `(asOf, knownAt)`, computed only
 * from the plan. `null` means the system had not learned any version covering
 * that real-world instant yet.
 */
export function expectedFactAt(fact: PlannedFact, asOf: number, knownAt: number): PlannedFactVersion | null {
  const candidates = fact.versions.filter((version) =>
    version.knownFrom <= knownAt && version.validFrom <= asOf && (version.validUntil === undefined || version.validUntil > asOf));
  if (!candidates.length) return null;
  // Disjoint intervals by construction, so at most one survives. Assert it.
  if (candidates.length > 1) throw new Error(`timeline plan is not disjoint for ${fact.key}`);
  return candidates[0];
}

/** Deterministic `(asOf, knownAt)` pairs, biased onto and around plan boundaries. */
export function randomCutPoints(plan: TimelinePlan, count: number, seed = 424242): { asOf: string; knownAt: string }[] {
  const random = seededRandom(seed);
  const cuts: { asOf: string; knownAt: string }[] = [];
  const span = plan.bounds.end - plan.bounds.start;
  for (let index = 0; index < count; index++) {
    const pick = (): number => {
      const roll = random();
      if (roll < 0.35) {
        // Sit exactly on a boundary: the half-open interval edges are where an
        // off-by-one in the temporal predicate actually shows up.
        return plan.boundaries[Math.floor(random() * plan.boundaries.length)];
      }
      if (roll < 0.5) {
        return plan.boundaries[Math.floor(random() * plan.boundaries.length)] + (random() < 0.5 ? -1 : 1);
      }
      return plan.bounds.start + Math.floor(random() * span);
    };
    const knownAt = pick();
    // asOf is independent of knownAt: retrospective AND prospective views both occur.
    const asOf = pick();
    cuts.push({ asOf: iso(asOf), knownAt: iso(knownAt) });
  }
  return cuts;
}

interface Placement { at: number; apply: (memory: LocalMemory) => void }

/**
 * Writes the plan into a store. Records are applied in ascending transaction
 * time with the store's injected clock moved to match, so `createdAt` is the
 * plan's `knownFrom` and nothing depends on the real wall clock.
 *
 * @param clock a mutable holder the caller also passed to `now: () => new Date(clock.value)`
 */
export function applyTimelinePlan(memory: LocalMemory, plan: TimelinePlan, clock: { value: number }): { ids: Map<string, string[]>; total: number } {
  const ids = new Map<string, string[]>();
  const push = (key: string, id: string): void => { ids.set(key, [...(ids.get(key) ?? []), id]); };
  const placements: Placement[] = [];

  for (const fact of plan.facts) {
    for (const version of fact.versions) {
      placements.push({
        at: version.knownFrom,
        apply: (store) => {
          const record = store.store({
            text: version.text, kind: 'fact', key: fact.key, trust: 'verified',
            evidence: `seed://timeline/${fact.key}/${version.validFrom}`,
            source: { uri: `seed://timeline/${fact.key}`, author: 'timeline-fixture' },
            validFrom: iso(version.validFrom),
            ...(version.validUntil === undefined ? {} : { validUntil: iso(version.validUntil) }),
            metadata: { entity: fact.entity, value: version.value },
          });
          push(fact.key, record.id);
        },
      });
    }
  }
  for (const note of plan.plain) {
    placements.push({ at: note.createdAt, apply: (store) => { push('plain', store.store({ text: note.text, kind: 'observation', source: { uri: 'seed://timeline/note' } }).id); } });
  }
  for (const entry of plan.corrections) {
    const marker = entry.text;
    placements.push({ at: entry.createdAt, apply: (store) => { push('correction', store.store({ text: entry.text, kind: 'decision', source: { uri: 'seed://timeline/policy' } }).id); } });
    placements.push({
      at: entry.correctedAt,
      apply: (store) => {
        const original = (ids.get('correction') ?? []).find((id) => store.get(id)?.text === marker);
        if (!original) throw new Error('correction target missing');
        push('correction', store.correct(original, { text: entry.correctedText, source: { uri: 'seed://timeline/policy' }, reason: 'timeline fixture correction' }).id);
      },
    });
  }
  for (const entry of plan.untrusted) {
    placements.push({ at: entry.createdAt, apply: (store) => { push('untrusted', store.store({ text: entry.text, kind: 'observation', trust: 'untrusted', source: { uri: 'seed://timeline/rumour' } }).id); } });
  }

  // Stable sort by transaction time; ties keep insertion order so the run is reproducible.
  placements
    .map((placement, index) => ({ placement, index }))
    .sort((a, b) => a.placement.at - b.placement.at || a.index - b.index)
    .forEach(({ placement }) => { clock.value = placement.at; placement.apply(memory); });

  return { ids, total: [...ids.values()].reduce((sum, list) => sum + list.length, 0) };
}
