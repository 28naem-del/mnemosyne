#!/usr/bin/env node
/**
 * Derives the two LoCoMo parts this run was scored on, from the licensed corpus
 * the reader supplies. The corpus itself is CC BY-NC 4.0 and is not redistributed
 * here, so the slice is described as code rather than shipped as data.
 *
 * A part is made of WHOLE sessions — never a session cut in the middle — taken in
 * session order until the next session would push it past the turn budget, and it
 * keeps only the questions whose every evidence turn survives the cut. That keeps
 * the evidence denominator honest: each kept question is answerable from the kept
 * turns, so a missing hit is a retrieval miss and not a corpus artefact.
 *
 *   node make-parts.mjs --corpus benchmarks/data/locomo10.json --out /tmp/parts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { corpus: { type: 'string' }, out: { type: 'string' }, turns: { type: 'string' } } });
const budget = Number(values.turns ?? 220);
const corpus = JSON.parse(readFileSync(resolve(values.corpus ?? 'benchmarks/data/locomo10.json'), 'utf8'));
const out = resolve(values.out ?? 'reports/matched-run-2026-09-15-llm-extraction/parts');
mkdirSync(out, { recursive: true, mode: 0o700 });

const part = (index) => {
  const sample = corpus[index], conversation = sample.conversation;
  const sessions = Object.keys(conversation).filter(key => /^session_\d+$/.test(key)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  const kept = [];
  let turns = 0;
  for (const session of sessions) {
    if (kept.length && turns + conversation[session].length > budget) break;
    kept.push(session); turns += conversation[session].length;
  }
  const sliced = Object.fromEntries(Object.entries(conversation).filter(([key]) => !/^session_\d+/.test(key)));
  for (const session of kept) {
    sliced[session] = conversation[session];
    if (typeof conversation[`${session}_date_time`] === 'string') sliced[`${session}_date_time`] = conversation[`${session}_date_time`];
  }
  const ids = new Set(kept.flatMap(session => conversation[session].map(turn => turn.dia_id)));
  const qa = (sample.qa ?? []).filter(question => Array.isArray(question.evidence) && question.evidence.length && question.evidence.every(id => ids.has(id)));
  const { conversation: _conversation, qa: _qa, ...rest } = sample;
  return { doc: [{ ...rest, conversation: sliced, qa }], sessions: kept.length, total: sessions.length, turns, questions: qa.length };
};

for (const [index, name] of [[0, 'partA'], [1, 'partB']]) {
  const built = part(index);
  const target = join(out, `locomo-${name}.json`);
  writeFileSync(target, JSON.stringify(built.doc), { mode: 0o600 });
  console.log(`${name}: conversation ${index}, sessions ${built.sessions}/${built.total}, turns ${built.turns}, questions ${built.questions} -> ${target}`);
}
