/**
 * Assembles the passage a cross-encoder sees when a candidate turn is reranked
 * together with its in-session neighbours.
 *
 * Why this exists: a cross-encoder scores each turn against the query IN
 * ISOLATION, which is precisely the judgement a session index exists to correct.
 * "Yeah, I did that too" is evidence because of the turns above it, and a model
 * that never sees those turns ranks it at the floor however it got into the pool.
 * Measured on LoCoMo, the derived indexes are worth +7.58 all-evidence-hit at the
 * fusion stage and only +3.13 survives the reranker.
 *
 * Two properties are load-bearing and neither is a matter of taste:
 *
 * 1. THE CANDIDATE COMES FIRST. `encodeWordPiecePair` keeps `second.slice(0,
 *    lengthB)` — a PREFIX of the passage — so whatever sits after the candidate is
 *    what a long pair loses. Putting the candidate at the head of the passage is
 *    therefore a structural guarantee that it survives, not a hope, and it is
 *    pinned by `passage.startsWith(candidate)`.
 * 2. THE BUDGET IS COUNTED IN PIECES, NOT BYTES. `basicTokenize` emits one token
 *    per punctuation character, so bytes-per-token has no safe lower bound and a
 *    byte cap cannot bound a token-priced resource. The caller supplies the same
 *    counter the encoder uses, so the budget is exact on the bundled path.
 *
 * Neighbours are admitted WHOLE or skipped. A turn cut mid-sentence is worse than
 * absent: it changes what the model reads without telling it anything, and it
 * makes the passage depend on where a byte boundary happened to fall.
 */

/** An in-session neighbour of the candidate, with its signed distance in turns. */
export interface ContextNeighbour {
  readonly id: string;
  /** Turns before (negative) or after (positive) the candidate. Never 0. */
  readonly offset: number;
  readonly text: string;
}

export interface ContextBudget {
  /** Pieces available for context, after the query and the candidate are paid for. */
  readonly maxTokens: number;
  /** The encoder's own piece count for a string. */
  readonly count: (text: string) => number;
}

/** A rerank passage may not exceed this, so neither may anything we assemble. */
const MAX_PASSAGE_BYTES = 65_536;

/**
 * The pair capacity the budget is computed against.
 *
 * 512 is the bundled cross-encoder's window and the BERT-family default. A model
 * with a smaller window does not break the guarantee that matters: the encoder
 * truncates the END of the passage, and the candidate is at the front, so the
 * only thing a tighter window can cost is context we would rather have had.
 */
const PAIR_TOKENS = 512;

/**
 * Selection order is nearest-first and previous-before-next at equal distance:
 * the antecedent of "Yeah, I did that too" is almost always the preceding turn.
 * Layout order is session order, so the model reads the exchange as a dialogue.
 * They are deliberately different orders, which is safe only because neighbours
 * are never truncated — nothing depends on which end of the block gets cut.
 */
const byProximity = (a: ContextNeighbour, b: ContextNeighbour): number =>
  Math.abs(a.offset) - Math.abs(b.offset) || Math.sign(a.offset) - Math.sign(b.offset) || a.id.localeCompare(b.id);

const bySession = (a: ContextNeighbour, b: ContextNeighbour): number => a.offset - b.offset || a.id.localeCompare(b.id);

/**
 * Returns `candidate` with as many of its neighbours appended as the budget
 * allows, or `candidate` unchanged when none fit.
 *
 * The separator is a newline and nothing else. `basicTokenize` maps every
 * whitespace character to a space and drops empty splits, so a newline costs zero
 * pieces and a doubled one is a literal no-op at the token level — claiming it as
 * a turn boundary the model can see would be false. A novel separator token would
 * cost pieces and is out of distribution for the bundled cross-encoder, which was
 * trained on prose passages. Each turn keeps whatever speaker prefix its own text
 * already carries, which on conversational corpora is the real separator.
 */
export function buildContextPassage(candidate: string, neighbours: readonly ContextNeighbour[], budget: ContextBudget): string {
  if (budget.maxTokens <= 0 || !neighbours.length) return candidate;
  const admitted: ContextNeighbour[] = [];
  let remaining = budget.maxTokens;
  for (const neighbour of [...neighbours].sort(byProximity)) {
    if (!neighbour.text || neighbour.offset === 0) continue;
    const cost = budget.count(neighbour.text);
    // Skip, do not stop: a long turn at distance 1 must not hide a short one at
    // distance 2, and the rule has to be total so the passage is deterministic.
    if (cost > remaining) continue;
    remaining -= cost;
    admitted.push(neighbour);
  }
  if (!admitted.length) return candidate;
  const passage = `${candidate}\n${admitted.sort(bySession).map(neighbour => neighbour.text).join('\n')}`;
  // The isolated passage was already inside this bound, so falling back to it is
  // always legal; growing past the bound would make the reranker throw.
  return Buffer.byteLength(passage) > MAX_PASSAGE_BYTES ? candidate : passage;
}

/**
 * Pieces left for context once the query and the whole candidate are paid for.
 *
 * `encodeWordPiecePair` spends three positions on `[CLS]`/`[SEP]`/`[SEP]`, so the
 * body is `PAIR_TOKENS - 3`. Budgeting against what is actually left means the
 * encoder's own equalising loop never fires on a passage we assembled: the
 * candidate is never shortened AND the context is never silently cut either.
 * A candidate that already fills the pair yields 0, and the passage stays exactly
 * what it is today.
 */
export function contextBudget(queryTokens: number, candidateTokens: number, limit: number): number {
  return Math.max(0, Math.min(limit, PAIR_TOKENS - 3 - queryTokens - candidateTokens));
}
