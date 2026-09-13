import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { planMigration } from '../src/migration/planner.js';
import { MigrationPlanError, type MigrationArtifact, type MigrationPlan, type MigrationPlanOptions, type MigrationProfile } from '../src/migration/types.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const digest = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const base: MigrationPlanOptions = { sourceStore: 'fixture-export', sourceOwner: { allowedIds: ['owner'], assumeMissing: 'owner' }, destination: { workspaceId: 'workspace', agentId: 'destination' }, evaluatedAt: '2026-09-13T00:00:00Z', acknowledgePartial: true };
const artifact = (profile: MigrationProfile, value: unknown, name = 'fixture.json'): MigrationArtifact => ({ name, profile, bytes: encode(JSON.stringify(value)) });
const mem0 = (id = 'm1', extra: Record<string, unknown> = {}) => ({ id, memory: 'Prefers concise updates.', user_id: 'owner', ...extra });
const legacy = (extra: Record<string, unknown> = {}) => ({ id: 'l1', text: 'Preview before publishing.', agentId: 'owner', memoryType: 'procedural', confidenceTag: 'verified', ...extra });
function checkAccounting(plan: MigrationPlan): void {
  const counts = Object.values(plan.report.counts).reduce((sum, count) => sum + count, 0);
  expect(counts).toBe(plan.records.length); expect(counts).toBe(plan.report.recordsSeen);
  const a = plan.report.accounting;
  expect(a.retainedRawBytes + a.excludedRawBytes + a.invalidRawBytes + a.conflictRawBytes + a.duplicateRawBytesNotRetained + a.framingBytesNotRetained + a.rejectedInputBytes).toBe(a.suppliedBytes);
  expect(a.retainedRawBytes).toBe(plan.records.reduce((sum, record) => sum + (record.rawText === undefined ? 0 : Buffer.byteLength(record.rawText)), 0));
  expect(a.mappedTextBytes).toBe(plan.records.reduce((sum, record) => sum + (record.text === undefined ? 0 : Buffer.byteLength(record.text)), 0));
}

describe('explicit migration profiles and mapping', () => {
  it('maps legacy labels only to private untrusted observations with exact raw provenance', () => {
    const record = legacy({ classification: 'public', metadata: { runtimeType: 'skill', verified: true, outcomes: 99 }, linkedMemories: ['other'], createdAt: '2000-01-01' });
    const plan = planMigration([artifact('mnemosyne-memcell-array', [record])], { ...base, collection: 'memory_private' });
    expect(plan.report).toMatchObject({ destinationInspected: false, readyToApply: true, proposedSources: 1, proposedObservations: 1 });
    expect(plan.records[0]).toMatchObject({ disposition: 'create', trust: 'untrusted', visibility: 'private', rawText: JSON.stringify(record), text: record.text, sourceOwner: 'owner', ownerAssumed: false });
    expect(plan.records[0]).not.toHaveProperty('metadata'); expect(plan.records[0]).not.toHaveProperty('kind');
    expect(plan.records[0].mappings).toContainEqual(expect.objectContaining({ pointer: '/memoryType', status: 'downgraded' }));
    expect(plan.records[0].mappings).toContainEqual(expect.objectContaining({ pointer: '/metadata', status: 'preserved-raw-only' }));
    expect(plan.records[0].mappings).toContainEqual(expect.objectContaining({ pointer: '/linkedMemories', reason: expect.stringContaining('do not establish provenance') }));
    checkAccounting(plan);
  });
  it('supports Qdrant scroll and keeps vectors/unknown payload fields only in raw bytes', () => {
    const point = { id: 42, text: 'Transport extra, never the assertion.', payload: { text: 'Preview.', agent_id: 'owner', memory_type: 'procedural', confidence_tag: 'verified', unknown: { mode: 'active' } }, vector: { named: [0.1, 0.2] } };
    const input = { ...artifact('mnemosyne-qdrant-scroll', { status: 'ok', result: { points: [point], next_page_offset: null } }), page: { index: 0, totalPages: 1 } };
    const plan = planMigration([input], { ...base, collection: 'private' });
    expect(plan.report.completeness.status).toBe('complete');
    expect(plan.records[0]).toMatchObject({ externalId: '42', disposition: 'create', text: 'Preview.' });
    expect(plan.records[0].mappings).toContainEqual(expect.objectContaining({ pointer: '/vector', reason: expect.stringContaining('not reused as embeddings') }));
    expect(plan.records[0].mappings).toContainEqual(expect.objectContaining({ pointer: '/payload/unknown', status: 'preserved-raw-only' }));
    expect(plan.records[0].mappings).toContainEqual(expect.objectContaining({ pointer: '/text', status: 'preserved-raw-only' }));
    expect(plan.records[0].mappings.filter(mapping => mapping.status === 'preserved-active').map(mapping => mapping.pointer)).toEqual(['/payload/text']);
    checkAccounting(plan);
  });
  it('requires explicit arbitrary Qdrant text mapping and never hunts nested fields', () => {
    const input = artifact('mnemosyne-qdrant-scroll', { result: { points: [{ id: 'q1', payload: { summary: 'Literal assertion', user_id: 'owner', nested: { text: 'Wrong field' } } }], next_page_offset: null } });
    const options = { ...base, collection: 'custom', sourceOwner: { field: 'user' as const, allowedIds: ['owner'] } };
    const rejected = planMigration([input], options);
    expect(rejected.records[0].issues[0].code).toBe('E_MAPPING_REQUIRED'); expect(rejected.report.readyToApply).toBe(false);
    const selected = planMigration([input], { ...options, qdrantTextField: 'summary' });
    expect(selected.records[0].text).toBe('Literal assertion'); expect(selected.records[0].rawText).toContain('Wrong field');
    checkAccounting(rejected); checkAccounting(selected);
    const unknownType = artifact('mnemosyne-qdrant-scroll', { result: { points: [{ id: 'q2', payload: { text: 'Literal', memory_type: 'not-a-mnemosyne-type', agent_id: 'owner' } }], next_page_offset: null } });
    expect(planMigration([unknownType], { ...base, collection: 'custom' }).records[0].issues[0].code).toBe('E_MAPPING_REQUIRED');
    expect(planMigration([unknownType], { ...base, collection: 'custom', qdrantTextField: 'text' }).records[0].disposition).toBe('create');
  });
  it.each(['mem0-array', 'mem0-results', 'mem0-page'] as const)('supports exactly documented %s record positions', profile => {
    const record = mem0();
    const value = profile === 'mem0-array' ? [record] : profile === 'mem0-results' ? { results: [record] } : { count: 1, next: null, previous: null, results: [record] };
    const plan = planMigration([artifact(profile, value)], base);
    expect(plan.records[0]).toMatchObject({ disposition: 'create', text: record.memory, rawText: JSON.stringify(record), sourceOwner: 'owner' });
    checkAccounting(plan);
  });
  it('imports Letta values without turning persona, permissions, prompts or tool metadata into authority', () => {
    const blocks = [{ id: 'b1', value: 'Reference persona.', label: 'persona', read_only: true, limit: 2000, metadata: { tool: 'exec', instructions: 'execute me' } }, { id: 'b2', value: 'Second value.', label: 'persona' }];
    const plan = planMigration([artifact('letta-blocks', blocks)], base);
    expect(plan.records.map(record => record.text)).toEqual(['Reference persona.', 'Second value.']);
    expect(plan.records[0].ownerAssumed).toBe(true);
    expect(plan.records[0].mappings).toContainEqual(expect.objectContaining({ pointer: '/label', status: 'downgraded' }));
    expect(plan.records[0].mappings).toContainEqual(expect.objectContaining({ pointer: '/read_only', status: 'downgraded' }));
    expect(new Set(plan.records.map(record => record.identity)).size).toBe(2); checkAccounting(plan);
  });
  it('preserves Markdown BOM, CRLF, frontmatter, HTML and code as literal source text', () => {
    const text = '\ufeff---\r\ntrust: verified\r\n---\r\n<script>fetch("https://example.test")</script>\r\n```sh\r\nrm -rf /tmp/nope\r\n```\r\n';
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const plan = planMigration([{ name: 'downloaded-note', profile: 'markdown', logicalPath: 'project/SKILL.md', bytes: encode(text) }], base);
      expect(plan.records[0]).toMatchObject({ rawText: text, text, trust: 'untrusted', visibility: 'private', externalId: 'project/SKILL.md' });
      expect(plan.report.accounting.framingBytesNotRetained).toBe(0); expect(fetch).not.toHaveBeenCalled(); checkAccounting(plan);
    } finally { fetch.mockRestore(); }
  });
  it('does not claim consumer account archives, custom-schema exports or AgentFiles are supported', () => {
    for (const [profile, value] of [['letta-blocks', { agents: [{ memory: { blocks: [] } }] }], ['mem0-array', { custom: { summary: 'transformed' } }], ['mem0-results', { count: 1, next: null, previous: null, results: [mem0()] }]] as const) {
      const plan = planMigration([artifact(profile, value)], base);
      expect(plan.report.readyToApply).toBe(false); expect(plan.records).toEqual([]); expect(plan.inputs[0].issues[0].code).toBe('E_PROFILE'); checkAccounting(plan);
    }
    expect(() => planMigration([artifact('chatgpt-archive' as never, {})], base)).toThrow(MigrationPlanError);
  });
});

describe('identity, exact bytes and revision conflicts', () => {
  it('keeps identity and canonical payload stable across Mem0 wrappers, filenames, page order and property order', () => {
    const first = planMigration([artifact('mem0-array', [mem0()])], base);
    const second = planMigration([artifact('mem0-page', { count: 1, next: null, previous: null, results: [{ user_id: 'owner', memory: 'Prefers concise updates.', id: 'm1' }] }, 'renamed.json')], base);
    expect(first.records[0].identity).toBe(second.records[0].identity); expect(first.records[0].canonicalHash).toBe(second.records[0].canonicalHash); expect(first.planHash).not.toBe(second.planHash);
    const forward = planMigration([artifact('mem0-array', [mem0('a'), mem0('b')])], base);
    const reverse = planMigration([artifact('mem0-array', [mem0('b'), mem0('a')])], base);
    expect(forward.records.map(record => record.identity).sort()).toEqual(reverse.records.map(record => record.identity).sort());
  });
  it('keeps legacy identity across camelCase and Qdrant, while transport payload differences remain explicit conflicts', () => {
    const options = { ...base, collection: 'legacy' };
    const camel = artifact('mnemosyne-memcell-array', [legacy()], 'camel.json');
    const snake = artifact('mnemosyne-qdrant-scroll', { result: { points: [{ id: 'l1', payload: { text: 'Preview before publishing.', agent_id: 'owner', memory_type: 'procedural', confidence_tag: 'verified' } }], next_page_offset: null } }, 'snake.json');
    expect(planMigration([camel], options).records[0].identity).toBe(planMigration([snake], options).records[0].identity);
    const combined = planMigration([camel, snake], options);
    expect(combined.report.counts.conflict).toBe(2); expect(combined.records.every(record => record.rawText === undefined)).toBe(true); checkAccounting(combined);
    expect(planMigration([camel], options).records[0].identity).not.toBe(planMigration([camel], { ...options, collection: 'other' }).records[0].identity);
  });
  it('preserves each exact JSON record span without keeping wrapper copies', () => {
    const raw = '{ "memory" : "Hi ☕",\r\n"user_id":"owner", "id" : "m1", "unknown" : { "x": 1 } }';
    const bytes = encode(`\ufeff \r\n{"results":[\n ${raw}\n],"wrapper":"not retained"} \n`);
    const plan = planMigration([{ name: 'exact.json', profile: 'mem0-results', bytes }], base), record = plan.records[0];
    expect(record.rawText).toBe(raw); expect(record.rawHash).toBe(digest(raw)); expect(record.rawHash).toBe(digest(bytes.subarray(record.startByte, record.endByte))); expect(plan.inputs[0].sha256).toBe(digest(bytes));
    expect(record.pointer).toBe('/results/0'); expect(JSON.stringify(plan)).not.toContain('not retained\\"'); checkAccounting(plan);
  });
  it('deduplicates equivalent canonical JSON and accounts for the discarded serialization', () => {
    const first = artifact('mem0-array', [mem0()], 'one.json');
    const second = { name: 'two.json', profile: 'mem0-results' as const, bytes: encode('{"results":[{ "user_id":"owner", "memory":"Prefers concise updates.", "id":"m1" }]}') };
    const plan = planMigration([first, second], base);
    expect(plan.report.counts).toMatchObject({ create: 1, unchanged: 1, conflict: 0 }); expect(plan.records[1].rawText).toBeUndefined(); expect(plan.report.accounting.duplicateRawBytesNotRetained).toBe(plan.records[1].rawBytes); checkAccounting(plan);
  });
  it('rejects changed unknown metadata under the same source identity without picking a revision', () => {
    const plan = planMigration([artifact('mem0-array', [mem0('m1', { metadata: { x: 1 } }), mem0('m1', { metadata: { x: 2 } })])], base);
    expect(plan.report.counts.conflict).toBe(2); expect(plan.report.readyToApply).toBe(false); expect(plan.records.every(record => record.rawText === undefined && record.text === undefined)).toBe(true); checkAccounting(plan);
  });
  it('retains separate provenance for equal text with different IDs and Markdown logical paths', () => {
    expect(planMigration([artifact('mem0-array', [mem0('a'), mem0('b')])], base).report.counts.create).toBe(2);
    const files = ['one.md', 'two.md'].map(logicalPath => ({ name: logicalPath, logicalPath, profile: 'markdown' as const, bytes: encode('Same') }));
    const plan = planMigration(files, base); expect(plan.report.counts.create).toBe(2); expect(plan.records[0].identity).not.toBe(plan.records[1].identity);
    expect(planMigration(files, { ...base, acknowledgePartial: false }).report).toMatchObject({ readyToApply: true, completeness: { status: 'complete' } });
    const renamed = planMigration([{ ...files[0], name: 'new-download-name' }], base); expect(plan.records[0].identity).toBe(renamed.records[0].identity);
  });
  it('canonicalizes exact decimal forms without collapsing rounded fractional metadata changes', () => {
    const plan = (numbers: string[]) => planMigration([{ name: 'numbers.json', profile: 'mem0-array', bytes: encode(`[${numbers.map(value => `{"id":"same","memory":"text","user_id":"owner","value":${value}}`).join(',')}]`) }], base);
    expect(plan(['1.0', '1e0', '10e-1']).report.counts).toMatchObject({ create: 1, unchanged: 2 });
    expect(plan(['0.1', '0.10000000000000001']).report.counts.conflict).toBe(2);
    expect(plan(['1', '1.0000000000000001']).report.counts.conflict).toBe(2);
  });
});

describe('scope and conservative lifecycle handling', () => {
  it('excludes foreign owners without retaining their bytes, even when upstream visibility says public', () => {
    const input = [mem0('mine'), mem0('foreign', { user_id: 'another-owner', memory: 'A private secret phrase.', visibility: 'public' })];
    const plan = planMigration([artifact('mem0-array', input)], base);
    expect(plan.report.counts).toMatchObject({ create: 1, excluded: 1 }); expect(plan.records[1].rawText).toBeUndefined(); expect(plan.records[1].text).toBeUndefined(); expect(JSON.stringify(plan)).not.toContain('A private secret phrase.'); checkAccounting(plan);
  });
  it('requires explicit missing-owner assumptions and never silently replaces a malformed owner', () => {
    for (const owner of [undefined, 99, '', { nested: 'owner' }]) {
      const options = { ...base, sourceOwner: { allowedIds: ['owner'] } };
      const row = { id: 'missing', memory: 'text', ...(owner === undefined ? {} : { user_id: owner }) };
      const plan = planMigration([artifact('mem0-array', [row])], options);
      expect(plan.records[0].disposition).toBe('invalid'); expect(plan.report.readyToApply).toBe(false); checkAccounting(plan);
    }
    const assumed = planMigration([artifact('mem0-array', [{ id: 'a', memory: 'text' }])], base);
    expect(assumed.records[0]).toMatchObject({ ownerAssumed: true, sourceOwner: 'owner' });
    const malformed = planMigration([artifact('mem0-array', [mem0('a', { user_id: 99 })])], base);
    expect(malformed.records[0].disposition).toBe('invalid');
  });
  it('supports explicit agent selection without confusing it with a user owner', () => {
    const input = artifact('mem0-array', [mem0('a', { user_id: 'foreign-user', agent_id: 'owner' })]);
    expect(planMigration([input], base).records[0].disposition).toBe('excluded');
    expect(planMigration([input], { ...base, sourceOwner: { field: 'agent', allowedIds: ['owner'] } }).records[0].disposition).toBe('create');
  });
  it.each([{ deleted: true }, { deleted: 'false' }, { replaced_by: 'other' }, { lifecycle_state: 'archived' }, { expiration_date: '2020-01-01T00:00:00Z' }, { expiration_date: '2027-01-01' }, { expiration_date: 'not-a-date' }])('quarantines inactive or ambiguous source lifecycle %j', extra => {
    const plan = planMigration([artifact('mem0-array', [mem0('m1', extra)])], { ...base, trust: 'observed' });
    expect(plan.records[0]).toMatchObject({ disposition: 'quarantine', trust: 'untrusted', mappedTextBytes: 0 }); expect(plan.records[0].text).toBeUndefined(); expect(plan.records[0].rawText).toBeDefined(); expect(plan.report.readyToApply).toBe(true); checkAccounting(plan);
  });
  it('keeps future expiration as a claimed timestamp and only accepts explicit observed trust', () => {
    const plan = planMigration([artifact('mem0-array', [mem0('m1', { expiration_date: '2027-01-01T00:00:00Z' })])], { ...base, trust: 'observed' });
    expect(plan.records[0]).toMatchObject({ disposition: 'create', trust: 'observed' }); expect(plan.records[0]).not.toHaveProperty('validUntil');
    expect(() => planMigration([artifact('mem0-array', [mem0()])], { ...base, trust: 'verified' as never })).toThrow(MigrationPlanError);
  });
  it('quarantines secret legacy records and blank/NUL sources without inventing facts', () => {
    const secret = planMigration([artifact('mnemosyne-memcell-array', [legacy({ classification: 'secret' })])], { ...base, collection: 'private' });
    expect(secret.records[0].disposition).toBe('quarantine');
    for (const text of ['', ' \r\n\ufeff', 'text\0with NUL']) {
      const plan = planMigration([{ name: 'notes', profile: 'markdown', logicalPath: 'notes.md', bytes: encode(text) }], base);
      expect(plan.records[0]).toMatchObject({ disposition: 'quarantine', rawText: text, mappedTextBytes: 0 }); expect(plan.records[0].text).toBeUndefined(); checkAccounting(plan);
      expect(plan.report).toMatchObject({ proposedSources: 0, proposedEncodedSourceControls: 1 });
    }
    const escaped = planMigration([artifact('mem0-array', [mem0('a', { memory: 'decoded\0NUL' })])], base);
    expect(escaped.records[0]).toMatchObject({ disposition: 'quarantine', rawText: expect.stringContaining('\\u0000') }); checkAccounting(escaped);
  });
});

describe('completeness, bounded rejection and pure output', () => {
  it('requires acknowledgement of unknown bare-array completeness', () => {
    const plan = planMigration([artifact('mem0-array', [mem0()])], { ...base, acknowledgePartial: false });
    expect(plan.report).toMatchObject({ readyToApply: false, completeness: { status: 'unknown' } }); expect(plan.report.issues[0].code).toBe('E_PARTIAL_ACK_REQUIRED');
  });
  it('accepts a supplied full page inventory in either order and never follows continuation URLs', () => {
    const first = { ...artifact('mem0-page', { count: 2, next: 'https://example.test/next', previous: null, results: [mem0('a')] }, 'first'), page: { index: 0, totalPages: 2 } };
    const last = { ...artifact('mem0-page', { count: 2, next: null, previous: 'https://example.test/previous', results: [mem0('b')] }, 'last'), page: { index: 1, totalPages: 2 } };
    for (const files of [[first, last], [last, first]]) { const plan = planMigration(files, { ...base, acknowledgePartial: false }); expect(plan.report).toMatchObject({ readyToApply: true, completeness: { status: 'complete', suppliedUniqueIds: 2, upstreamTotals: [2] } }); checkAccounting(plan); }
    const partial = planMigration([last], base); expect(partial.report.completeness.status).toBe('partial');
  });
  it('reports count mismatches, duplicate pages and contradictory continuation markers as partial', () => {
    const one = { ...artifact('mem0-page', { count: 2, next: 'https://example.test/next', previous: null, results: [mem0()] }), page: { index: 0, totalPages: 1 } };
    const plan = planMigration([one], base); expect(plan.report.completeness.status).toBe('partial'); expect(plan.report.completeness.reasons.join(' ')).toMatch(/continuation.*totals/);
    const duplicate = planMigration([one, { ...one, name: 'duplicate' }], base); expect(duplicate.report.completeness.reasons.join(' ')).toContain('more than once'); checkAccounting(duplicate);
  });
  it('treats previous-page markers as evidence of missing or contradictory page declarations', () => {
    const value = { count: 1, next: null, previous: 'https://example.test/earlier', results: [mem0()] };
    const file = artifact('mem0-page', value);
    const declaredFirst = planMigration([{ ...file, page: { index: 0, totalPages: 1 } }], { ...base, acknowledgePartial: false });
    expect(declaredFirst.inputs[0].hasPrevious).toBe(true); expect(declaredFirst.report).toMatchObject({ readyToApply: false, completeness: { status: 'partial' } });
    expect(declaredFirst.report.completeness.reasons.join(' ')).toContain('previous-page marker contradicts');
    expect(planMigration([file], base).report.completeness.status).toBe('partial');
    const missingPrevious = planMigration([{ ...artifact('mem0-page', { ...value, previous: null }), page: { index: 1, totalPages: 2 } }], base);
    expect(missingPrevious.report.completeness.reasons.join(' ')).toContain('previous-page marker contradicts'); checkAccounting(declaredFirst);
  });
  it.each(['[{"id":"x","memory":"sensitive","user_id":"owner","id":"y"}]', '[{"id":9007199254740993,"text":"sensitive"}]', '[{"id":"x","memory":"sensitive"}', '[{"id":"x","memory":"\\ud800"}]'])('rejects malformed or unsafe JSON with sanitized boundaries: %s', text => {
    const plan = planMigration([{ name: 'bad.json', profile: 'mem0-array', bytes: encode(text) }], base);
    expect(plan.records).toEqual([]); expect(plan.inputs[0].rejectedInputBytes).toBe(Buffer.byteLength(text)); expect(plan.inputs[0].unparsedBytes).toBeTypeOf('number'); expect(JSON.stringify(plan)).not.toContain('sensitive'); expect(plan.report.readyToApply).toBe(false); checkAccounting(plan);
  });
  it('rejects malformed UTF-8 without replacement characters or retained source text', () => {
    for (const profile of ['mem0-array', 'markdown'] as const) {
      const plan = planMigration([{ name: 'bad', profile, ...(profile === 'markdown' ? { logicalPath: 'bad.md' } : {}), bytes: new Uint8Array([0xff, 0xfe]) }], base);
      expect(plan.report.readyToApply).toBe(false); expect(plan.records.every(record => record.rawText === undefined)).toBe(true); checkAccounting(plan);
    }
  });
  it('rejects lossy numeric identity conversion even for fractions rounded to a safe integer', () => {
    const make = (id: string) => planMigration([{ name: 'id.json', profile: 'mnemosyne-memcell-array', bytes: encode(`[{"id":${id},"text":"text","agentId":"owner"}]`) }], { ...base, collection: 'legacy' });
    expect(make('1.0000000000000001').records[0].disposition).toBe('invalid'); expect(make('1e0').records[0].externalId).toBe('1');
    expect(make('9007199254740992').inputs[0].issues[0].code).toBe('E_NUMBER_RANGE');
  });
  it('rejects lossy integral count/offset conversions instead of claiming completeness', () => {
    const input = { name: 'count.json', profile: 'mem0-page' as const, bytes: encode(`{"count":1.0000000000000001,"next":null,"previous":null,"results":[${JSON.stringify(mem0())}]}`), page: { index: 0, totalPages: 1 } };
    const plan = planMigration([input], base); expect(plan.report.readyToApply).toBe(false); expect(plan.inputs[0].issues[0].code).toBe('E_PROFILE'); checkAccounting(plan);
    for (const offset of ['1.0000000000000001', '-1', '0.5']) {
      const qdrant = { name: 'qdrant.json', profile: 'mnemosyne-qdrant-scroll' as const, bytes: encode(`{"result":{"points":[],"next_page_offset":${offset}}}`) };
      expect(planMigration([qdrant], { ...base, collection: 'legacy' }).report.readyToApply).toBe(false);
    }
  });
  it('enforces aggregate input, record, source unit, profile and logical path bounds without truncating', () => {
    expect(() => planMigration([artifact('mem0-array', [mem0()])], { ...base, limits: { maxInputBytes: 4 } })).toThrow(MigrationPlanError);
    expect(() => planMigration([artifact('mem0-array', [mem0('a'), mem0('b')])], { ...base, limits: { maxRecords: 1 } })).toThrow(MigrationPlanError);
    const large = planMigration([artifact('mem0-array', [mem0()])], { ...base, limits: { maxSourceBytes: 8 } }); expect(large.records[0].issues[0].code).toBe('E_SOURCE_LIMIT'); checkAccounting(large);
    expect(() => planMigration([artifact('mem0-array', [])], { ...base, limits: { maxSourceBytes: 65537 } })).toThrow(MigrationPlanError);
    expect(() => planMigration([artifact('mem0-array', []), artifact('letta-blocks', [], 'letta')], base)).toThrow(MigrationPlanError);
    expect(() => planMigration([artifact('mnemosyne-memcell-array', [])], base)).toThrow(MigrationPlanError);
    for (const logicalPath of ['../file', '/absolute', 'a//b', 'a/./b', 'a\\b']) expect(() => planMigration([{ name: 'file', profile: 'markdown', logicalPath, bytes: encode('text') }], base)).toThrow(MigrationPlanError);
  });
  it('snapshots byte views, rejects shared memory, and returns a deeply immutable content-bound plan', () => {
    const backing = encode(`prefix${JSON.stringify([mem0()])}suffix`), view = backing.subarray(6, backing.length - 6);
    const plan = planMigration([{ name: 'subarray', profile: 'mem0-array', bytes: view }], base); const hashBefore = plan.planHash;
    backing.fill(0); expect(plan.records[0].rawText).toBe(JSON.stringify(mem0())); expect(plan.planHash).toBe(hashBefore);
    const frozen = (value: unknown): void => { if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen); } }; frozen(plan);
    expect(() => planMigration([{ name: 'shared', profile: 'markdown', logicalPath: 'shared.md', bytes: new Uint8Array(new SharedArrayBuffer(8)) }], base)).toThrow(MigrationPlanError);
    expect(planMigration([artifact('mem0-array', [mem0()])], base).planHash).toBe(planMigration([artifact('mem0-array', [mem0()])], base).planHash);
  });
  it('rejects accessors, sparse arrays, invalid timestamps and malformed policy values', () => {
    const getter = vi.fn(() => 'store'); const options = { ...base }; Object.defineProperty(options, 'sourceStore', { get: getter });
    expect(() => planMigration([artifact('mem0-array', [])], options)).toThrow(MigrationPlanError); expect(getter).not.toHaveBeenCalled();
    expect(() => planMigration(new Array(1), base)).toThrow(MigrationPlanError);
    for (const evaluatedAt of ['2026-02-30T00:00:00Z', '2026-09-13', 'now', '2026-09-13T00:00:00']) expect(() => planMigration([artifact('mem0-array', [])], { ...base, evaluatedAt })).toThrow(MigrationPlanError);
    expect(() => planMigration([artifact('mem0-array', [])], { ...base, destination: { ...base.destination, visibility: 'workspace' } } as never)).toThrow(MigrationPlanError);
    expect(() => planMigration([artifact('mem0-array', [])], { ...base, sourceOwner: { allowedIds: ['owner'], assumeMissing: 'foreign' } })).toThrow(MigrationPlanError);
  });
  it('never executes Array-subclass callbacks or permits them to bypass artifact and owner bounds', () => {
    const invoked = vi.fn();
    class HostileArray<T> extends Array<T> {
      override map<U>(_callback: (value: T, index: number, array: T[]) => U): U[] { invoked(); return Array.from({ length: 257 }, () => artifact('mem0-array', []) as U); }
      override some(_callback: (value: T, index: number, array: T[]) => unknown): boolean { invoked(); return false; }
      override [Symbol.iterator](): ArrayIterator<T> { invoked(); return super[Symbol.iterator](); }
    }
    const artifacts = new HostileArray<MigrationArtifact>(artifact('mem0-array', []));
    expect(() => planMigration(artifacts, base)).toThrow(MigrationPlanError);
    const owners = new HostileArray<string>('owner');
    expect(() => planMigration([artifact('mem0-array', [])], { ...base, sourceOwner: { allowedIds: owners } })).toThrow(MigrationPlanError);
    expect(invoked).not.toHaveBeenCalled();
  });
  it('treats prototype-shaped raw keys as source data without exposing or freezing host prototypes', () => {
    const wasFrozen = Object.isFrozen(Object.prototype);
    const file = { name: 'prototype.json', profile: 'mem0-array' as const, bytes: encode('[{"id":"m1","memory":"text","user_id":"owner","__proto__":{"polluted":true},"constructor":"source data","toString":"source data"}]') };
    const plan = planMigration([file], base);
    expect(Object.isFrozen(Object.prototype)).toBe(wasFrozen);
    expect(plan.records[0].mappings.every(mapping => typeof mapping.reason === 'string')).toBe(true);
    for (const pointer of ['/__proto__', '/constructor', '/toString']) expect(plan.records[0].mappings).toContainEqual(expect.objectContaining({ pointer, status: 'preserved-raw-only', reason: expect.any(String) }));
    expect(plan.records[0].rawText).toContain('"__proto__":{"polluted":true}'); expect(plan.report.readyToApply).toBe(true); checkAccounting(plan);
  });
});
