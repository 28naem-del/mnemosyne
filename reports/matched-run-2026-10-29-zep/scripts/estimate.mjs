// Credit estimate: replicate the adapter's episode payload (speaker: text, per 4096-byte chunk) and Zep's 1 credit / 350 bytes rule.
import { readFileSync } from 'node:fs';
const W = new URL('../wt/', import.meta.url);
const cb = await import(new URL('dist/evaluation/corpus-benchmark.js', W));
const split = (await import(new URL(process.argv[2], W)))['splitEvaluationText'];
const credit = s => Math.max(1, Math.ceil(Buffer.byteLength(s) / 350));
function est(ds, perCorpus) {
  const out = [];
  for (const c of ds.corpora) { let ep = 0, cr = 0, by = 0;
    for (const t of c.turns) for (const p of split(t.text, 4096)) { const piece = p.text; const d = t.speaker ? `${t.speaker}: ${piece}` : piece; ep++; cr += credit(d); by += Buffer.byteLength(d); }
    out.push({ id: c.id, episodes: ep, credits: cr, bytes: by }); }
  return out;
}
const prov = { dataset: 'x', revision: 'x', license: 'x', sourceUrl: 'https://x', sourceSha256: 'a'.repeat(64), sourceBytes: 1 };
const lo = cb.adaptLoCoMoCorpus(JSON.parse(readFileSync(new URL('benchmarks/data/locomo10.json', W))), prov, { onMalformedEvidence: 'skip' });
const l = est(lo); console.log('LoCoMo per conversation:'); for (const r of l) console.log(' ', r.id, r.episodes, 'ep', r.credits, 'cr');
console.log('LoCoMo total', l.reduce((a, r) => a + r.episodes, 0), 'episodes', l.reduce((a, r) => a + r.credits, 0), 'credits');
let lm = JSON.parse(readFileSync(new URL('benchmarks/data/longmemeval_s_cleaned.json', W))).filter((_, i) => i % 10 === 0);
const ld = cb.adaptLongMemEvalCorpus(lm, prov, { timestampPolicy: 'question-day' });
const m = est(ld); const tot = m.reduce((a, r) => a + r.credits, 0);
console.log('LongMemEval stride10: corpora', m.length, 'episodes', m.reduce((a, r) => a + r.episodes, 0), 'credits', tot, 'mean/haystack', Math.round(tot / m.length), 'min', Math.min(...m.map(r => r.credits)), 'max', Math.max(...m.map(r => r.credits)));
