#!/usr/bin/env node
// Replays a store at every cut point in a JSON file and prints one state hash
// per line, in order. Exists so the determinism gate can be asserted ACROSS
// PROCESSES: the test spawns this twice and diffs the two outputs. Same-process
// repetition would prove nothing about module-load order, hash-map iteration or
// a cached clock.
//
//   node scripts/replay-cut-hashes.mjs --db FILE --workspace W --agent A --cuts CUTS.json
//
// Reads only. Never writes to the store.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createLocalMemory } from '../dist/local/index.js';
import { replayState } from '../dist/local/replay.js';

const { values } = parseArgs({
  options: {
    db: { type: 'string' }, workspace: { type: 'string' }, agent: { type: 'string' },
    cuts: { type: 'string' }, 'index-mode': { type: 'string' },
  },
});
for (const name of ['db', 'workspace', 'agent', 'cuts']) {
  if (!values[name]) { process.stderr.write(`replay-cut-hashes: --${name} is required\n`); process.exit(2); }
}

const cuts = JSON.parse(readFileSync(values.cuts, 'utf8'));
if (!Array.isArray(cuts)) { process.stderr.write('replay-cut-hashes: --cuts must hold a JSON array\n'); process.exit(2); }

const memory = createLocalMemory({
  path: values.db, workspaceId: values.workspace, agentId: values.agent,
  // The ledger is not part of the state and writing recall entries would make a
  // read-only replay mutate the file it is replaying.
  ledger: false,
  ...(values['index-mode'] ? { indexMode: values['index-mode'] } : {}),
});
try {
  const lines = [];
  for (const cut of cuts) lines.push(replayState(memory, cut).stateSha256);
  process.stdout.write(`${lines.join('\n')}\n`);
} finally {
  memory.close();
}
