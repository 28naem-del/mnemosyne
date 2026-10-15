#!/usr/bin/env node
// T1.7 (lane t17) post-hoc analysis over a run-accuracy-gate.mjs output: per-question-type
// breakdown, abstention accounting, and an exact two-sided McNemar test against a baseline run's
// rows (restricted to the ids both runs share). Reads existing JSON only; makes no network call.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const read = path => JSON.parse(path.endsWith('.gz') ? gunzipSync(readFileSync(path)) : readFileSync(path, 'utf8'));

const runPath = flag('run'), baselinePath = flag('baseline');
if (!runPath) throw new Error('Missing --run <output.json>');
const run = read(runPath);
const rows = run.rows;

function wilson95(k, n) {
  if (n === 0) return [0, 0];
  const z = 1.959963984540054, p = k / n, denom = 1 + z * z / n;
  const centre = p + z * z / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return [(centre - half) / denom, (centre + half) / denom];
}

// Exact two-sided binomial test, p=0.5, for McNemar's b/c cells.
function binomTwoSidedExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const logChoose = (n, k) => {
    let acc = 0;
    for (let i = 0; i < k; i++) acc += Math.log(n - i) - Math.log(i + 1);
    return acc;
  };
  const pmf = k => Math.exp(logChoose(n, k) - n * Math.log(2));
  const target = pmf(Math.min(b, c));
  let total = 0;
  for (let k = 0; k <= n; k++) { const p = pmf(k); if (p <= target * (1 + 1e-9)) total += p; }
  return Math.min(1, total);
}

function breakdown(rows) {
  const byType = new Map();
  for (const r of rows) {
    const key = r.questionType ?? 'unknown';
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(r);
  }
  const summarize = (list) => {
    const n = list.length;
    const judgeCorrect = list.filter(r => r.judge === true).length;
    const exact = list.filter(r => r.exact).length;
    const abstainedAll = list.filter(r => r.action === 'abstain').length;
    const answerable = list.filter(r => r.answerability === 'answerable');
    const unanswerable = list.filter(r => r.answerability === 'unanswerable');
    const abstainedAnswerable = answerable.filter(r => r.action === 'abstain').length;
    const answeredWrongAnswerable = answerable.filter(r => r.action !== 'abstain' && r.judge !== true).length;
    const unanswerableAbstained = unanswerable.filter(r => r.action === 'abstain').length;
    const unanswerableJudgeTrue = unanswerable.filter(r => r.judge === true).length;
    return { n, judgeCorrect, judgePct: n ? +(100 * judgeCorrect / n).toFixed(1) : 0, exact,
      abstainedAll, abstainedAnswerable, answerableN: answerable.length, answeredWrongAnswerable,
      unanswerableN: unanswerable.length, unanswerableAbstained, unanswerableJudgeTrue };
  };
  const out = { all: summarize(rows) };
  for (const [type, list] of byType) out[type] = summarize(list);
  return out;
}

const result = { run: runPath, n: rows.length, breakdown: breakdown(rows) };
const ci = wilson95(result.breakdown.all.judgeCorrect, result.breakdown.all.n);
result.judgeAccuracyWilson95 = { low: +ci[0].toFixed(4), high: +ci[1].toFixed(4) };

if (baselinePath) {
  const baseline = read(baselinePath);
  const baseRows = new Map(baseline.rows.map(r => [r.questionId, r]));
  const shared = rows.filter(r => baseRows.has(r.questionId));
  let b = 0, c = 0; // b: baseline correct, run wrong. c: baseline wrong, run correct.
  for (const r of shared) {
    const base = baseRows.get(r.questionId);
    const baseCorrect = base.judge === true, runCorrect = r.judge === true;
    if (baseCorrect && !runCorrect) b++;
    else if (!baseCorrect && runCorrect) c++;
  }
  const baseCorrectShared = shared.filter(r => baseRows.get(r.questionId).judge === true).length;
  const runCorrectShared = shared.filter(r => r.judge === true).length;
  result.mcnemar = { pairedN: shared.length, baselineCorrect: baseCorrectShared, runCorrect: runCorrectShared,
    gained: c, lost: b, pTwoSidedExact: +binomTwoSidedExact(b, c).toFixed(4) };
}

console.log(JSON.stringify(result, null, 2));
