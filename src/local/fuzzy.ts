/**
 * Guarded single-edit fuzzy matching for lexical term expansion and name phrases.
 *
 * Typo tolerance is a precision hazard: every extra edit a matcher forgives
 * multiplies the terms one query token can reach, and short or repetitive tokens
 * reach the most. So the matcher is deliberately narrow and deterministic:
 *
 * - optimal string alignment (OSA) distance of at most 1, so one insertion,
 *   deletion, substitution, or one swap of two adjacent letters ("typsecript");
 * - both tokens at least {@link FUZZY_MIN_LENGTH} characters, so abbreviations
 *   such as "k8s"/"k9s" never fuzz into each other;
 * - the first {@link FUZZY_PREFIX} characters equal, so an edit can never change
 *   what a word starts with ("mango" does not reach "mongo");
 * - letters only — a token carrying a digit is an identifier, a version or a
 *   number, and one edit there names a different thing;
 * - an information guard: a token needs at least {@link FUZZY_MIN_DISTINCT}
 *   distinct letters, so runs such as "aaaa" or "abab" cannot match anything.
 *
 * No model, no randomness and no locale-dependent comparison is involved, so the
 * zero-model lexical path stays reproducible bit for bit.
 */

export const FUZZY_MIN_LENGTH = 4;
export const FUZZY_PREFIX = 2;
export const FUZZY_MIN_DISTINCT = 3;

const LETTERS = /^\p{L}+$/u;

/** Whether a token may take part in a fuzzy match at all. */
export function fuzzyEligible(token: string): boolean {
  if (token.length < FUZZY_MIN_LENGTH || !LETTERS.test(token)) return false;
  return new Set(token).size >= FUZZY_MIN_DISTINCT;
}

/**
 * OSA distance, bounded: returns the exact distance when it is at most `limit`
 * and `limit + 1` otherwise. The band keeps this O(n·limit) rather than O(n·m),
 * which matters because expansion runs against a vocabulary, not one word.
 */
export function boundedOsaDistance(a: string, b: string, limit = 1): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const n = a.length, m = b.length;
  let previous2 = new Array<number>(m + 1).fill(0);
  let previous = Array.from({ length: m + 1 }, (_, j) => j);
  let current = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, previous2[j - 2] + 1);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    [previous2, previous, current] = [previous, current, previous2];
  }
  return Math.min(previous[m], limit + 1);
}

/** True when two DIFFERENT tokens are one guarded edit apart. Equal tokens are
 * an exact match, not a fuzzy one, and return false so callers can tell them apart. */
export function fuzzyMatch(a: string, b: string): boolean {
  if (a === b || !fuzzyEligible(a) || !fuzzyEligible(b)) return false;
  if (a.slice(0, FUZZY_PREFIX) !== b.slice(0, FUZZY_PREFIX)) return false;
  return boundedOsaDistance(a, b, 1) === 1;
}

/** The `[low, high)` range of terms sharing a token's guarded prefix, for an
 * index range scan over a sorted vocabulary. `\u{10FFFF}` sorts after every
 * code point a tokenizer can emit. */
export function fuzzyPrefixRange(token: string): [string, string] {
  const prefix = token.slice(0, FUZZY_PREFIX);
  return [prefix, `${prefix}\u{10FFFF}`];
}

/**
 * Every string one guarded edit away from `token` that keeps its first
 * {@link FUZZY_PREFIX} characters: deletions, substitutions, insertions and
 * adjacent transpositions at or after that prefix.
 *
 * Generated rather than searched for, so expansion costs a bounded number of
 * exact index seeks whatever the vocabulary size — a range scan over every
 * stored term sharing a two-letter prefix would grow with the corpus. The
 * alphabet is `a`–`z` plus the token's own letters, so a typo of a non-Latin
 * word can still repeat or drop its own letters; a substitution by a letter the
 * word does not contain outside `a`–`z` is not generated. Callers re-check each
 * candidate with {@link fuzzyMatch}.
 */
export function singleEditCandidates(token: string): string[] {
  if (!fuzzyEligible(token)) return [];
  const letters = [...new Set([...'abcdefghijklmnopqrstuvwxyz', ...token])].sort();
  const characters = [...token];
  const out = new Set<string>();
  for (let index = FUZZY_PREFIX; index <= characters.length; index++) {
    const head = characters.slice(0, index).join(''), tail = characters.slice(index).join('');
    for (const letter of letters) out.add(head + letter + tail);
    if (index < characters.length) {
      out.add(head + characters.slice(index + 1).join(''));
      for (const letter of letters) if (letter !== characters[index]) out.add(head + letter + characters.slice(index + 1).join(''));
      if (index + 1 < characters.length) out.add(head + characters[index + 1] + characters[index] + characters.slice(index + 2).join(''));
    }
  }
  out.delete(token);
  return [...out].filter((candidate) => fuzzyMatch(token, candidate)).sort();
}
