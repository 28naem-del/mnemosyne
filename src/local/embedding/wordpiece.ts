/**
 * BERT WordPiece tokenization, implemented locally so the deterministic core
 * carries no tokenizer dependency and no network access.
 *
 * This follows the reference `BertTokenizer` pipeline exactly: clean the text,
 * isolate CJK characters, split on whitespace, lowercase and strip accents,
 * split on punctuation, then greedily match the longest vocabulary subword with
 * a `##` continuation prefix. Any word longer than 100 characters, or one whose
 * prefix is absent from the vocabulary, becomes `[UNK]` rather than being
 * silently approximated.
 */

export interface WordPieceVocabulary {
  readonly ids: ReadonlyMap<string, number>;
  readonly unk: number;
  readonly cls: number;
  readonly sep: number;
  readonly pad: number;
  readonly size: number;
}

const SPECIAL = ['[UNK]', '[CLS]', '[SEP]', '[PAD]'] as const;
const MAX_WORD_CHARS = 100;

/** Parses a `vocab.txt` whose line number is the token identifier. */
export function loadWordPieceVocabulary(contents: string): WordPieceVocabulary {
  const ids = new Map<string, number>();
  const lines = contents.split('\n');
  // A trailing newline produces one empty final entry that is not a token.
  const length = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  for (let index = 0; index < length; index++) {
    const token = lines[index].replace(/\r$/, '');
    if (!ids.has(token)) ids.set(token, index);
  }
  for (const token of SPECIAL) if (!ids.has(token)) throw new Error(`Vocabulary is missing the ${token} token`);
  return Object.freeze({ ids, unk: ids.get('[UNK]')!, cls: ids.get('[CLS]')!, sep: ids.get('[SEP]')!, pad: ids.get('[PAD]')!, size: length });
}

const isWhitespace = (character: string): boolean => character === ' ' || character === '\t' || character === '\n' || character === '\r' || /\p{Zs}/u.test(character);
const isControl = (character: string): boolean => character !== '\t' && character !== '\n' && character !== '\r' && /\p{C}/u.test(character);
// The reference implementation treats the ASCII symbol blocks as punctuation
// alongside the Unicode P categories, and does NOT include the S categories.
const isPunctuation = (character: string): boolean => {
  const code = character.codePointAt(0)!;
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126) || /\p{P}/u.test(character);
};
const isCjk = (character: string): boolean => {
  const code = character.codePointAt(0)!;
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x20000 && code <= 0x2a6df)
    || (code >= 0x2a700 && code <= 0x2b73f) || (code >= 0x2b740 && code <= 0x2b81f) || (code >= 0x2b820 && code <= 0x2ceaf)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x2f800 && code <= 0x2fa1f);
};

/** Clean, isolate CJK, split on whitespace, lowercase, strip accents, split on punctuation. */
export function basicTokenize(text: string): string[] {
  let cleaned = '';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 0 || code === 0xfffd || isControl(character)) continue;
    if (isWhitespace(character)) { cleaned += ' '; continue; }
    cleaned += isCjk(character) ? ` ${character} ` : character;
  }
  const tokens: string[] = [];
  for (const whitespaceToken of cleaned.split(' ')) {
    if (!whitespaceToken) continue;
    // Accents are combining marks, so stripping happens after decomposition.
    const normalized = [...whitespaceToken.toLowerCase().normalize('NFD')].filter(character => !/\p{Mn}/u.test(character)).join('');
    let current = '';
    for (const character of normalized) {
      if (isPunctuation(character)) { if (current) { tokens.push(current); current = ''; } tokens.push(character); }
      else current += character;
    }
    if (current) tokens.push(current);
  }
  return tokens;
}

function wordPiece(word: string, vocabulary: WordPieceVocabulary): number[] {
  if ([...word].length > MAX_WORD_CHARS) return [vocabulary.unk];
  const pieces: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let matched: number | undefined;
    while (start < end) {
      const candidate = vocabulary.ids.get(start > 0 ? `##${word.slice(start, end)}` : word.slice(start, end));
      if (candidate !== undefined) { matched = candidate; break; }
      end--;
    }
    // A single unmatched piece makes the entire word unknown, as in the reference.
    if (matched === undefined) return [vocabulary.unk];
    pieces.push(matched);
    start = end;
  }
  return pieces;
}

/**
 * How many wordpieces `text` contributes to a sequence, excluding the special
 * tokens the encoders add around it.
 *
 * Callers that budget a pair need the encoder's OWN unit. Bytes are not an
 * approximation of it: `basicTokenize` emits one token per punctuation character,
 * so a byte cap cannot bound a token-priced resource, and a word count is only a
 * lower bound because wordpiece splits unknown words.
 */
export function countWordPieces(text: string, vocabulary: WordPieceVocabulary): number {
  return pieces(text, vocabulary).length;
}

/**
 * Encodes one sequence as `[CLS] … [SEP]`, truncating the body so the result
 * never exceeds `maxTokens`. Truncation is reported so callers can disclose it
 * rather than silently embedding a prefix of a long document.
 */
export function encodeWordPiece(text: string, vocabulary: WordPieceVocabulary, maxTokens: number): { ids: number[]; truncated: boolean } {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 2 || maxTokens > 8192) throw new TypeError('maxTokens must be between 2 and 8192');
  const body = maxTokens - 2;
  const ids: number[] = [vocabulary.cls];
  let truncated = false;
  for (const word of basicTokenize(text)) {
    for (const id of wordPiece(word, vocabulary)) {
      if (ids.length - 1 >= body) { truncated = true; break; }
      ids.push(id);
    }
    if (truncated) break;
  }
  ids.push(vocabulary.sep);
  return { ids, truncated };
}

/** Subword identifiers for one text, with no special tokens and no truncation. */
function pieces(text: string, vocabulary: WordPieceVocabulary): number[] {
  const ids: number[] = [];
  for (const word of basicTokenize(text)) for (const id of wordPiece(word, vocabulary)) ids.push(id);
  return ids;
}

/**
 * Encodes a sequence PAIR as `[CLS] a [SEP] b [SEP]`, the input format a BERT
 * cross-encoder is trained on, with `typeIds` marking which segment each position
 * belongs to. Unlike two independent embeddings, the model attends across the
 * boundary, which is the whole reason a cross-encoder can rerank.
 *
 * Over-long pairs are truncated longest-first, matching the reference tokenizer:
 * tokens come off whichever sequence is currently longer, so a short query is
 * never cut to make room for a long passage.
 */
export function encodeWordPiecePair(a: string, b: string, vocabulary: WordPieceVocabulary, maxTokens: number): { ids: number[]; typeIds: number[]; truncated: boolean } {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 3 || maxTokens > 8192) throw new TypeError('maxTokens must be between 3 and 8192');
  const first = pieces(a, vocabulary), second = pieces(b, vocabulary);
  const body = maxTokens - 3;
  let lengthA = first.length, lengthB = second.length;
  const truncated = lengthA + lengthB > body;
  // The reference breaks a tie against the FIRST sequence, so `>=`, not `>`.
  while (lengthA + lengthB > body) { if (lengthA >= lengthB) lengthA--; else lengthB--; }
  const ids = [vocabulary.cls, ...first.slice(0, lengthA), vocabulary.sep, ...second.slice(0, lengthB), vocabulary.sep];
  const typeIds = ids.map((_, index) => index > lengthA + 1 ? 1 : 0);
  return { ids, typeIds, truncated };
}
