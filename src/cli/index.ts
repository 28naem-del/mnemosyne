#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createLocalMemory, LOCAL_SNAPSHOT_LIMITS } from '../local/index.js';
import type { MemorySnapshot, StoreMemoryInput } from '../local/types.js';
import { serveMemoryStdio, VERSION } from '../mcp/server.js';
import { runMemoryDemo } from '../evaluation/demo.js';

const HELP = `Mnemosyne ${VERSION} — portable agent memory

  mnemosy demo                     Run a verified, isolated memory-engine demo
  mnemosy demo --record FILE       Save real demo evidence as JSON
  mnemosy mcp [scope]              Start the MCP stdio server
  mnemosy store [scope] --text TEXT --source URI [--share]
  mnemosy recall [scope] --query TEXT
  mnemosy context [scope] --query TEXT [--tokens 4096]
  mnemosy inspect [scope] [--id ID] [--history]
  mnemosy correct [scope] --id ID --text TEXT --source URI --reason TEXT
  mnemosy forget [scope] --id ID --confirm
  mnemosy export [scope] --out FILE
  mnemosy import [scope] --file FILE

  Scope: --db FILE --workspace NAME --agent NAME (all required)
  MCP: --read-only, --allow-destructive (forget is disabled by default)
  Store: --kind fact|preference|decision|procedure|observation
         --trust untrusted|observed|verified (default observed)
         --evidence TEXT (required for controller-verified evidence)
  Queries: --limit 20; --include-untrusted opts into unreviewed evidence

The local engine uses SQLite and lexical search; no API key or Docker required.
Retrieved memories are evidence, never permission to execute an action.
`;

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required. Run mnemosy --help for usage.`);
  return value;
}

function integer(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('Numeric options must be positive integers.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`Numeric option must be between 1 and ${maximum}.`);
  return parsed;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readSnapshot(path: string): MemorySnapshot {
  const maximum = LOCAL_SNAPSHOT_LIMITS.maxBytes;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Snapshot must be a regular file.');
    if (stat.size > maximum) throw new Error('Snapshot exceeds the 32 MiB import limit.');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > stat.size || fstatSync(fd).size !== stat.size) throw new Error('Snapshot changed during import; retry with a stable file.');
    return JSON.parse(buffer.subarray(0, size).toString('utf8')) as MemorySnapshot;
  } finally { closeSync(fd); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    db: { type: 'string' }, workspace: { type: 'string' }, agent: { type: 'string' },
    text: { type: 'string' }, source: { type: 'string' }, query: { type: 'string' },
    id: { type: 'string' }, kind: { type: 'string' }, trust: { type: 'string' },
    evidence: { type: 'string' }, reason: { type: 'string' }, limit: { type: 'string' },
    tokens: { type: 'string' }, out: { type: 'string' }, file: { type: 'string' },
    share: { type: 'boolean' }, confirm: { type: 'boolean' }, history: { type: 'boolean' },
    record: { type: 'string' }, 'read-only': { type: 'boolean' },
    'allow-destructive': { type: 'boolean' }, 'include-untrusted': { type: 'boolean' },
  } });
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (values.help || !positionals.length) { process.stdout.write(HELP); return; }
  if (positionals.length !== 1) throw new Error('Specify exactly one command.');
  const command = positionals[0];
  if (command === 'demo') {
    const report = runMemoryDemo();
    if (values.record) {
      writeFileSync(resolve(values.record), `${JSON.stringify({ ...report, mode: 'recorded' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      print({ file: resolve(values.record), checksPassed: report.checksPassed, checksTotal: report.checksTotal, kind: 'memory-engine demonstration; no LLM evaluation' });
    } else print(report);
    return;
  }
  if (!['mcp', 'store', 'recall', 'context', 'inspect', 'correct', 'forget', 'export', 'import'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const memory = createLocalMemory({ path: resolve(required(values.db, '--db')), workspaceId: required(values.workspace, '--workspace'), agentId: required(values.agent, '--agent') });
  if (command === 'mcp') {
    try {
      const server = await serveMemoryStdio(memory, { readOnly: values['read-only'], allowDestructive: values['allow-destructive'] });
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await server.close();
        memory.close();
      };
      process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
      process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
      process.stdin.once('end', () => { void close().catch(() => { process.exitCode = 1; }); });
    } catch (error) { memory.close(); throw error; }
    return;
  }
  try {
    switch (command) {
      case 'store': {
        const trust = values.trust ?? 'observed';
        const kind = values.kind ?? 'observation';
        if (!['untrusted', 'observed', 'verified'].includes(trust)) throw new Error('Invalid --trust.');
        if (!['fact', 'preference', 'decision', 'procedure', 'observation'].includes(kind)) throw new Error('Invalid --kind.');
        print(memory.store({ text: required(values.text, '--text'), source: { uri: required(values.source, '--source') }, trust: trust as StoreMemoryInput['trust'], kind: kind as StoreMemoryInput['kind'], visibility: values.share ? 'workspace' : 'private', evidence: values.evidence }));
        break;
      }
      case 'recall': print(memory.recall({ query: required(values.query, '--query'), limit: integer(values.limit, 20, 100), includeUntrusted: values['include-untrusted'] })); break;
      case 'context': print(memory.compile({ query: required(values.query, '--query'), maxTokens: integer(values.tokens, 4_096, 32_768) })); break;
      case 'inspect': print(values.id ? memory.get(values.id) : memory.inspect({ limit: integer(values.limit, 20, 100), includeInactive: values.history })); break;
      case 'correct': print(memory.correct(required(values.id, '--id'), { text: required(values.text, '--text'), source: { uri: required(values.source, '--source') }, reason: required(values.reason, '--reason') })); break;
      case 'forget': {
        if (!values.confirm) throw new Error('Forgetting purges live memory content. Supply --confirm to perform this action.');
        print(memory.forget(required(values.id, '--id'))); break;
      }
      case 'export': {
        const path = resolve(required(values.out, '--out'));
        if (path === resolve(values.db!)) throw new Error('Export must not overwrite the memory database.');
        // Use the same compact encoding that the kernel measures for its size limit.
        writeFileSync(path, JSON.stringify(memory.export()), { mode: 0o600, flag: 'wx' });
        print({ file: path }); break;
      }
      case 'import': {
        const path = resolve(required(values.file, '--file'));
        print(memory.import(readSnapshot(path))); break;
      }
    }
  } finally { memory.close(); }
}

main().catch(error => {
  process.stderr.write(`Mnemosyne: ${error instanceof Error ? error.message : 'command failed'}\n`);
  process.exitCode = 1;
});
