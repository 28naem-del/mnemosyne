import { test } from 'vitest';
import assert from 'node:assert/strict';
import { JsonSpanError, parseJsonWithSpans, type JsonSpanErrorCode, type JsonSpanNode, type JsonSpanParserOptions } from '../src/migration/json-spans.js';

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
function member(node: JsonSpanNode, key: string): JsonSpanNode {
  assert.equal(node.kind, 'object');
  if (node.kind !== 'object') throw new Error('Expected object fixture');
  const item = node.members.find(item => item.key === key); assert.ok(item); return item.value;
}
function elements(node: JsonSpanNode): readonly JsonSpanNode[] { assert.equal(node.kind, 'array'); if (node.kind !== 'array') throw new Error('Expected array fixture'); return node.elements; }
function rejected(input: string | Uint8Array, code: JsonSpanErrorCode, byteOffset?: number, options?: JsonSpanParserOptions): JsonSpanError {
  let error: unknown;
  try { parseJsonWithSpans(typeof input === 'string' ? encode(input) : input, options); } catch (caught) { error = caught; }
  assert.ok(error instanceof JsonSpanError); assert.equal(error.code, code);
  if (byteOffset !== undefined) assert.equal(error.byteOffset, byteOffset);
  assert.match(error.message, /^E_[A-Z0-9_]+ at byte \d+\.$/); assert.ok(error.message.length < 80);
  return error;
}

test('retains exact record spans in BOM/CRLF/multibyte Qdrant framing without reserialization', () => {
  const rawOne = '{ "id":42, "payload": {"text":"α😀", "unknown":1e-2} }';
  const rawTwo = '{\r\n"id":43,"payload":{"text":"é","future":{"x":true}}\r\n}';
  const source = '\uFEFF\r\n{ "status":"ok", "result":{"points":[ ' + rawOne + ',\r\n' + rawTwo + ' ],"next_page_offset":null}}\r\n';
  const bytes = encode(source), parsed = parseJsonWithSpans(bytes), points = elements(member(member(parsed.root, 'result'), 'points'));
  assert.equal(parsed.bomBytes, 3); assert.equal(parsed.byteLength, bytes.length); assert.equal(parsed.root.startByte, 5); assert.equal(parsed.root.endByte, bytes.length - 2);
  for (const [index, raw] of [rawOne, rawTwo].entries()) {
    const point = points[index], span = bytes.subarray(point.startByte, point.endByte);
    assert.equal(decode(span), raw); assert.deepEqual(parseJsonWithSpans(span).value, point.value);
  }
  assert.equal(member(member(points[0], 'payload'), 'unknown').value, 0.01);
  const number = member(member(points[0], 'payload'), 'unknown'); assert.equal(decode(bytes.subarray(number.startByte, number.endByte)), '1e-2');
  assert.ok(parsed.byteLength - points.reduce((sum, node) => sum + node.endByte - node.startByte, 0) > 0, 'wrapper/framing bytes remain separately accountable');
  assert.equal(parsed.value, parsed.root.value); assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(points)); assert.ok(Object.isFrozen(points[0].value));
});

test('navigates Mem0 results, Letta blocks and bare MemCell arrays using spans alone', () => {
  const fixtures = [
    { raw: '{"count":1,"next":null,"results":[ {"id":"m0","memory":"keep raw","unknown":[2,3]} ]}', key: 'results' },
    { raw: '[ { "id":"block-a", "label":"human", "value":"do not promote to system" } ]' },
    { raw: '[ {"id":"legacy-a","text":"raw record","memoryType":"procedural","confidenceTag":"verified"} ]' },
  ];
  for (const fixture of fixtures) {
    const bytes = encode(fixture.raw), parsed = parseJsonWithSpans(bytes), records = elements(fixture.key ? member(parsed.root, fixture.key) : parsed.root);
    assert.equal(records.length, 1); const record = records[0];
    assert.deepEqual(parseJsonWithSpans(bytes.subarray(record.startByte, record.endByte)).value, record.value);
    assert.ok(decode(bytes.subarray(record.startByte, record.endByte)).startsWith('{'));
  }
});

test('retains escaped key spans while decoding member names, and prevents prototype pollution', () => {
  const raw = '{"\\u0072esults":[],"__proto__":{"polluted":true},"constructor":"data"}', bytes = encode(raw), parsed = parseJsonWithSpans(bytes);
  assert.equal(parsed.root.kind, 'object'); if (parsed.root.kind !== 'object') throw new Error();
  const first = parsed.root.members[0]; assert.equal(first.key, 'results'); assert.equal(decode(bytes.subarray(first.keySpan.startByte, first.keySpan.endByte)), '"\\u0072esults"');
  assert.equal(Object.getPrototypeOf(parsed.value), null); assert.equal(Object.prototype.hasOwnProperty.call(parsed.value, '__proto__'), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('rejects duplicate keys after escaped key decoding, including astral Unicode', () => {
  const examples = ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"key":1,"k\\u0065y":2}}', '{"😀":1,"\\uD83D\\uDE00":2}', '{"__proto__":1,"__proto__":2}'];
  for (const source of examples) rejected(source, 'E_DUPLICATE_KEY');
  const source = '{"secret-key":1,"\\u0073ecret-key":2}', failure = rejected(source, 'E_DUPLICATE_KEY');
  assert.equal(failure.byteOffset, encode(source.slice(0, source.lastIndexOf('"\\u0073'))).length); assert.ok(!failure.message.includes('secret'));
  const distinct = parseJsonWithSpans(encode('{"é":1,"é":2}')); assert.equal(distinct.root.kind, 'object'); if (distinct.root.kind === 'object') assert.equal(distinct.root.members.length, 2, 'Unicode normalization must not silently merge keys');
});

test('accepts valid scalar strings and surrogate escape pairs, including escaped control values', () => {
  for (const source of ['"😀"', '"\\uD83D\\uDE00"', '"\\u0000\\b\\f\\n\\r\\t\\/\\\\\\\""', '"\\uFEFF"', '"한글 مرحبا é"']) assert.equal(parseJsonWithSpans(encode(source)).value, JSON.parse(source));
  const nested = parseJsonWithSpans(encode('{"x":"\\uD83D\\uDE00","y":"\\uFFFF"}')); assert.equal(member(nested.root, 'x').value, '😀');
});

test('rejects escaped lone surrogates in keys and values', () => {
  for (const source of ['"\\uD800"', '"\\uDC00"', '"\\uD800\\u0041"', '"\\uD800\\uD800"', '"\\uD800x"', '{"\\uDC00":1}', '["\\uD800"]']) rejected(source, 'E_UNICODE');
  rejected('"\\uD800"', 'E_UNICODE', 1); rejected('{"\\uDC00":1}', 'E_UNICODE', 2);
});

test('rejects malformed UTF-8, overlong forms, raw surrogate encodings and out-of-range code points with byte offsets', () => {
  const fixtures: [number[], number][] = [
    [[0xc0, 0xaf], 0], [[0x22, 0x80, 0x22], 1], [[0x22, 0xe0, 0x80, 0x80, 0x22], 2],
    [[0x22, 0xed, 0xa0, 0x80, 0x22], 2], [[0x22, 0xf4, 0x90, 0x80, 0x80, 0x22], 2],
    [[0x22, 0xf5, 0x80, 0x80, 0x80, 0x22], 1], [[0x22, 0xe2, 0x28, 0xa1, 0x22], 2], [[0x22, 0xf0, 0x90], 3],
  ];
  for (const [bytes, offset] of fixtures) rejected(new Uint8Array(bytes), 'E_UTF8', offset);
});

test('rejects unsafe integer numbers including decimal/exponent uint64 forms and nonfinite/underflow results', () => {
  for (const source of ['9007199254740992', '-9007199254740992', '18446744073709551615', '9.007199254740992e15', '900719925474099200e-2', '1.8446744073709551615e19', '1e309', '-1e309', '1e-400', '-1e-400']) rejected(source, 'E_NUMBER_RANGE', 0);
  rejected('{"id":18446744073709551615}', 'E_NUMBER_RANGE', 6);
  assert.equal(parseJsonWithSpans(encode('"18446744073709551615"')).value, '18446744073709551615');
});

test('accepts safe integers, valid negative exponents, finite fractions, subnormals and signed zero', () => {
  for (const source of ['9007199254740991', '-9007199254740991', '90071992547409910e-1', '12300e-2', '1e-3', '-2.5E-2', '9007199254740992e-1', '5e-324', '0e999999', '-0', '-0.0e-999999']) assert.ok(Object.is(parseJsonWithSpans(encode(source)).value, Number(source)), source);
});

test('rejects malformed JSON, unsupported whitespace and trailing bytes', () => {
  for (const source of ['', ' ', '\uFEFF', 'true false', '[', '{', '[1,]', '{"a":1,}', '{"a" 1}', '{a:1}', "{'a':1}", '+1', '01', '-01', '1.', '1e', '1e+', '--1', 'Infinity', 'NaN', 'undefined', '"unclosed', '"\\x20"', '"\\u12z4"', '"a\nb"', 'true\u0000', 'false\uFEFF', ' \uFEFF{}']) rejected(source, 'E_JSON');
  rejected('true false', 'E_JSON', 5); rejected('[]\r\ntrailing', 'E_JSON', 4);
});

test('accepts empty containers and primitive roots with root framing excluded from spans', () => {
  for (const source of ['{}', '[]', 'null', 'true', 'false', '123', '""']) {
    const bytes = encode(`\r\n ${source}\t\n`), parsed = parseJsonWithSpans(bytes);
    assert.equal(parsed.root.startByte, 3); assert.equal(parsed.root.endByte, bytes.length - 2); assert.equal(parsed.nodeCount, 1); assert.equal(parsed.bomBytes, 0);
    assert.equal(decode(bytes.subarray(parsed.root.startByte, parsed.root.endByte)), source);
  }
});

test('honors input byte views and does not mutate, retain or invoke iterators on caller bytes', () => {
  const backing = encode('prefix{"α":1}suffix'), input = backing.subarray(6, backing.length - 6), original = input.slice();
  Object.defineProperty(input, Symbol.iterator, { value: () => { throw new Error('Do not iterate caller bytes'); } });
  Object.defineProperty(input, 'constructor', { get() { throw new Error('Do not invoke caller species constructors'); } });
  const parsed = parseJsonWithSpans(input); for (let index = 0; index < input.length; index++) assert.equal(input[index], original[index]); assert.equal(parsed.root.startByte, 0); assert.equal(parsed.root.endByte, input.length);
  input.fill(0); assert.equal(member(parsed.root, 'α').value, 1);
});

test('enforces byte, depth and value-node budgets, including every tiny object member value', () => {
  rejected('"😀"', 'E_LIMIT', 5, { maxInputBytes: 5 });
  assert.equal(parseJsonWithSpans(encode('"😀"'), { maxInputBytes: 6 }).value, '😀');
  assert.equal(parseJsonWithSpans(encode('[]'), { maxDepth: 1 }).nodeCount, 1);
  rejected('[0]', 'E_LIMIT', 1, { maxDepth: 1 });
  const nestedEmpty = '['.repeat(32) + ']'.repeat(32); assert.equal(parseJsonWithSpans(encode(nestedEmpty)).nodeCount, 32);
  rejected('['.repeat(32) + '0' + ']'.repeat(32), 'E_LIMIT', 32);
  rejected('[1,2,3]', 'E_LIMIT', 5, { maxNodes: 3 });
  const object = '{"a":0,"b":0,"c":0}'; assert.equal(parseJsonWithSpans(encode(object)).nodeCount, 4); rejected(object, 'E_LIMIT', 17, { maxNodes: 3 });
});

test('enforces hard limits and rejects malformed options without invoking accessors', () => {
  for (const options of [{ maxInputBytes: 16 * 1024 * 1024 + 1 }, { maxDepth: 129 }, { maxNodes: 1000001 }, { maxDepth: 0 }, { maxNodes: -1 }, { maxInputBytes: NaN }, { maxNodes: 2.5 }]) rejected('null', 'E_LIMIT', 0, options);
  for (const options of [null, [], { unknown: 3 }, Object.create({ maxDepth: 4 }), Object.defineProperty({}, 'maxDepth', { get() { throw new Error('Accessor must not run'); } })]) rejected('null', 'E_INPUT', 0, options as JsonSpanParserOptions);
  for (const input of [null, '[]', [91, 93], new DataView(new ArrayBuffer(2))]) assert.throws(() => parseJsonWithSpans(input as unknown as Uint8Array), error => error instanceof JsonSpanError && error.code === 'E_INPUT');
});

test('bounds work for deep trees, huge exponent tokens and large populations of tiny members', () => {
  rejected('['.repeat(10000) + '0' + ']'.repeat(10000), 'E_LIMIT', 32);
  rejected('1e' + '9'.repeat(100000), 'E_NUMBER_RANGE', 0);
  const many = '{' + Array.from({ length: 10000 }, (_, index) => `"k${index}":0`).join(',') + '}';
  const failure = rejected(many, 'E_LIMIT', undefined, { maxNodes: 50 }); assert.ok(failure.byteOffset < 1000);
  rejected(new Uint8Array(4 * 1024 * 1024 + 1), 'E_LIMIT', 4 * 1024 * 1024);
});
