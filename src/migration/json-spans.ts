/** Pure bounded JSON parsing with byte-exact source spans; no I/O or evaluation. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface JsonSpan { readonly startByte: number; readonly endByte: number }
export interface JsonMember {
  readonly key: string;
  /** Includes the original quoted/escaped key token, excludes colon/whitespace. */
  readonly keySpan: JsonSpan;
  readonly value: JsonSpanNode;
}
export type JsonSpanNode =
  | (JsonSpan & { readonly kind: 'object'; readonly value: { readonly [key: string]: JsonValue }; readonly members: readonly JsonMember[] })
  | (JsonSpan & { readonly kind: 'array'; readonly value: readonly JsonValue[]; readonly elements: readonly JsonSpanNode[] })
  | (JsonSpan & { readonly kind: 'string'; readonly value: string })
  | (JsonSpan & { readonly kind: 'number'; readonly value: number })
  | (JsonSpan & { readonly kind: 'boolean'; readonly value: boolean })
  | (JsonSpan & { readonly kind: 'null'; readonly value: null });
export interface JsonSpanParserOptions { maxInputBytes?: number; maxDepth?: number; maxNodes?: number }
export interface JsonSpanDocument {
  readonly root: JsonSpanNode;
  readonly value: JsonValue;
  readonly byteLength: number;
  readonly bomBytes: 0 | 3;
  /** Counts value nodes, including containers; object key tokens are not nodes. */
  readonly nodeCount: number;
  readonly limits: Readonly<Required<JsonSpanParserOptions>>;
}
export type JsonSpanErrorCode = 'E_INPUT' | 'E_LIMIT' | 'E_UTF8' | 'E_JSON' | 'E_DUPLICATE_KEY' | 'E_UNICODE' | 'E_NUMBER_RANGE';
export class JsonSpanError extends Error {
  readonly code: JsonSpanErrorCode;
  readonly byteOffset: number;
  constructor(code: JsonSpanErrorCode, byteOffset: number) {
    super(`${code} at byte ${byteOffset}.`); this.name = 'JsonSpanError'; this.code = code; this.byteOffset = byteOffset;
  }
}
function reject(code: JsonSpanErrorCode, offset: number): never { throw new JsonSpanError(code, offset); }
function bounds(options: JsonSpanParserOptions): Readonly<Required<JsonSpanParserOptions>> {
  if (!options || typeof options !== 'object' || Array.isArray(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) reject('E_INPUT', 0);
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.getOwnPropertySymbols(options).length || Object.entries(descriptors).some(([key, descriptor]) => !['maxInputBytes', 'maxDepth', 'maxNodes'].includes(key) || !('value' in descriptor))) reject('E_INPUT', 0);
  const integer = (value: number | undefined, fallback: number, cap: number) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) reject('E_LIMIT', 0);
    return value;
  };
  return Object.freeze({ maxInputBytes: integer(options.maxInputBytes, 4 * 1024 * 1024, 16 * 1024 * 1024), maxDepth: integer(options.maxDepth, 32, 128), maxNodes: integer(options.maxNodes, 100000, 1000000) });
}
/** Validates Unicode scalars and identifies the first offending byte, including EOF. */
function validateUtf8(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length;) {
    const lead = bytes[index];
    if (lead < 0x80) { index++; continue; }
    let length: number, low = 0x80, high = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) length = 2;
    else if (lead >= 0xe0 && lead <= 0xef) { length = 3; if (lead === 0xe0) low = 0xa0; if (lead === 0xed) high = 0x9f; }
    else if (lead >= 0xf0 && lead <= 0xf4) { length = 4; if (lead === 0xf0) low = 0x90; if (lead === 0xf4) high = 0x8f; }
    else reject('E_UTF8', index);
    for (let offset = 1; offset < length; offset++) {
      if (index + offset >= bytes.length) reject('E_UTF8', bytes.length);
      const next = bytes[index + offset];
      if (next < (offset === 1 ? low : 0x80) || next > (offset === 1 ? high : 0xbf)) reject('E_UTF8', index + offset);
    }
    index += length;
  }
}
const digit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;
const hex = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : byte !== undefined && byte >= 0x41 && byte <= 0x46 ? byte - 0x41 + 10 : byte !== undefined && byte >= 0x61 && byte <= 0x66 ? byte - 0x61 + 10 : -1;

class Parser {
  readonly bytes: Uint8Array;
  readonly limits: Readonly<Required<JsonSpanParserOptions>>;
  readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  position: number;
  nodes = 0;
  constructor(bytes: Uint8Array, limits: Readonly<Required<JsonSpanParserOptions>>, start: number) { this.bytes = bytes; this.limits = limits; this.position = start; }
  whitespace(): void { while ([0x20, 0x09, 0x0a, 0x0d].includes(this.bytes[this.position])) this.position++; }
  expect(byte: number): void { if (this.bytes[this.position] !== byte) reject('E_JSON', this.position); this.position++; }
  unicodeUnit(): number {
    let value = 0;
    for (let count = 0; count < 4; count++) {
      const nibble = hex(this.bytes[this.position]); if (nibble < 0) reject('E_JSON', this.position);
      value = value * 16 + nibble; this.position++;
    }
    return value;
  }
  string(): { value: string; startByte: number; endByte: number } {
    const startByte = this.position; this.expect(0x22);
    while (this.position < this.bytes.length) {
      const offset = this.position, byte = this.bytes[this.position++];
      if (byte === 0x22) {
        // Only a lexically validated string token is decoded with JSON.parse.
        const value: string = JSON.parse(this.decoder.decode(this.bytes.subarray(startByte, this.position)));
        return { value, startByte, endByte: this.position };
      }
      if (byte < 0x20) reject('E_JSON', offset);
      if (byte !== 0x5c) continue;
      const escapeOffset = this.position, escaped = this.bytes[this.position++];
      if (escaped === 0x75) {
        const unit = this.unicodeUnit();
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (this.bytes[this.position] !== 0x5c || this.bytes[this.position + 1] !== 0x75) reject('E_UNICODE', offset);
          this.position += 2; const low = this.unicodeUnit();
          if (low < 0xdc00 || low > 0xdfff) reject('E_UNICODE', offset);
        } else if (unit >= 0xdc00 && unit <= 0xdfff) reject('E_UNICODE', offset);
      } else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escaped)) reject('E_JSON', escapeOffset);
    }
    return reject('E_JSON', this.position);
  }
  number(): JsonSpanNode {
    const startByte = this.position;
    if (this.bytes[this.position] === 0x2d) this.position++;
    if (this.bytes[this.position] === 0x30) {
      this.position++;
      if (digit(this.bytes[this.position])) reject('E_JSON', this.position);
    } else {
      if (!digit(this.bytes[this.position])) reject('E_JSON', this.position);
      while (digit(this.bytes[this.position])) this.position++;
    }
    if (this.bytes[this.position] === 0x2e) {
      this.position++; if (!digit(this.bytes[this.position])) reject('E_JSON', this.position);
      while (digit(this.bytes[this.position])) this.position++;
    }
    if (this.bytes[this.position] === 0x65 || this.bytes[this.position] === 0x45) {
      this.position++;
      if (this.bytes[this.position] === 0x2b || this.bytes[this.position] === 0x2d) this.position++;
      if (!digit(this.bytes[this.position])) reject('E_JSON', this.position);
      while (digit(this.bytes[this.position])) this.position++;
    }
    const token = this.decoder.decode(this.bytes.subarray(startByte, this.position)), value = Number(token);
    const significand = token.split(/[eE]/, 1)[0];
    // Fractional numbers use ordinary JS binary64 semantics. Reject unsafe
    // integer results, infinity, and nonzero values that underflow to zero.
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) || (value === 0 && /[1-9]/.test(significand))) reject('E_NUMBER_RANGE', startByte);
    return Object.freeze({ kind: 'number', value, startByte, endByte: this.position });
  }
  value(depth: number): JsonSpanNode {
    this.whitespace(); const startByte = this.position;
    if (depth > this.limits.maxDepth || ++this.nodes > this.limits.maxNodes) reject('E_LIMIT', startByte);
    const byte = this.bytes[this.position];
    if (byte === 0x7b) {
      this.position++; this.whitespace();
      const members: JsonMember[] = [], values: Record<string, JsonValue> = Object.create(null), seen = new Set<string>();
      if (this.bytes[this.position] !== 0x7d) while (true) {
        const key = this.string();
        if (seen.has(key.value)) reject('E_DUPLICATE_KEY', key.startByte); seen.add(key.value);
        this.whitespace(); this.expect(0x3a);
        const value = this.value(depth + 1); values[key.value] = value.value;
        members.push(Object.freeze({ key: key.value, keySpan: Object.freeze({ startByte: key.startByte, endByte: key.endByte }), value }));
        this.whitespace(); if (this.bytes[this.position] === 0x7d) break;
        this.expect(0x2c); this.whitespace();
      }
      this.expect(0x7d);
      return Object.freeze({ kind: 'object', value: Object.freeze(values), members: Object.freeze(members), startByte, endByte: this.position });
    }
    if (byte === 0x5b) {
      this.position++; this.whitespace(); const elements: JsonSpanNode[] = [];
      if (this.bytes[this.position] !== 0x5d) while (true) {
        elements.push(this.value(depth + 1));
        this.whitespace(); if (this.bytes[this.position] === 0x5d) break;
        this.expect(0x2c); this.whitespace();
      }
      this.expect(0x5d);
      return Object.freeze({ kind: 'array', value: Object.freeze(elements.map(node => node.value)), elements: Object.freeze(elements), startByte, endByte: this.position });
    }
    if (byte === 0x22) return Object.freeze({ kind: 'string', ...this.string() });
    if (byte === 0x2d || digit(byte)) return this.number();
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (byte !== literal.charCodeAt(0)) continue;
      for (let index = 0; index < literal.length; index++) this.expect(literal.charCodeAt(index));
      return value === null ? Object.freeze({ kind: 'null', value, startByte, endByte: this.position }) : Object.freeze({ kind: 'boolean', value, startByte, endByte: this.position });
    }
    return reject('E_JSON', this.position);
  }
}

/**
 * Spans are half-open UTF-8 offsets into the original supplied byte view. Root
 * framing whitespace/BOM is outside the root span. Slice each selected record
 * directly from the original input; JSON reserialization is not raw retention.
 */
export function parseJsonWithSpans(input: Uint8Array, options: JsonSpanParserOptions = {}): JsonSpanDocument {
  try {
    const limits = bounds(options);
    if (!(input instanceof Uint8Array)) reject('E_INPUT', 0);
    // Intrinsics honor a Buffer/subarray's byte view without invoking custom
    // iterators. Copy once so parsing cannot mutate or retain caller bytes.
    const byteLength = Reflect.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!.call(input) as number;
    if (byteLength > limits.maxInputBytes) reject('E_LIMIT', limits.maxInputBytes);
    const bytes = new Uint8Array(byteLength);
    Uint8Array.prototype.set.call(bytes, input);
    validateUtf8(bytes);
    const bomBytes = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    const parser = new Parser(bytes, limits, bomBytes), root = parser.value(1);
    parser.whitespace(); if (parser.position !== bytes.length) reject('E_JSON', parser.position);
    return Object.freeze({ root, value: root.value, byteLength, bomBytes, nodeCount: parser.nodes, limits });
  } catch (error) { if (error instanceof JsonSpanError) throw error; throw new JsonSpanError('E_INPUT', 0); }
}
