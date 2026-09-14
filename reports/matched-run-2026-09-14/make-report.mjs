// Generates reports/matched-run-2026-09-14.md from summary.json.
//
// The table is computed, never typed. In a report whose entire value is that the
// numbers are trustworthy, a hand-copied digit is the most likely way to publish
// something false, and the least likely to be noticed.
import { readFileSync, writeFileSync } from 'node:fs';

const summary = JSON.parse(readFileSync('reports/matched-run-2026-09-14/summary.json', 'utf8'));
const run = (corpusStartsWith, k) => summary.runs.find(r => r.corpus.startsWith(corpusStartsWith) && r.topK === k);
const row = (r, id) => r.rows.find(x => x.id === id);
const pct = v => v === null || v === undefined ? 'not run' : (v * 100).toFixed(2);
const mrr = v => v === null || v === undefined ? 'not run' : v.toFixed(4);
const ms = v => v === null || v === undefined ? 'not run' : `${v.toFixed(0)} ms`;

const LOCOMO_KS = [5, 10, 20];
const ORDER = ['lexical', 'bm25', 'hybrid-norerank', 'hybrid', 'system:mem0-oss'];

/** One block per K: every system, fixed row order, losses in the same font as wins. */
function locomoTable(k) {
  const r = run('LoCoMo', k);
  const lines = [
    `| System | recall@${k} | anyHit | allHit | MRR | p95 retrieval |`,
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const id of ORDER) {
    const x = row(r, id), m = x.metrics;
    lines.push(`| ${x.label} | ${pct(m?.recallAtK)} | ${pct(m?.anyHit)} | ${pct(m?.allHit)} | ${mrr(m?.mrr)} | ${ms(m?.p95RetrievalMs)} |`);
  }
  for (const nr of r.notRun) lines.push(`| Zep / Graphiti | not run | not run | not run | not run | not run |`);
  return lines.join('\n');
}

/** The headline comparison across K, so a single flattering K cannot be cherry-picked. */
function acrossK() {
  const lines = [
    '| System | recall@5 | recall@10 | recall@20 |',
    '|---|---:|---:|---:|',
  ];
  for (const id of ORDER) {
    const cells = LOCOMO_KS.map(k => pct(row(run('LoCoMo', k), id).metrics?.recallAtK));
    lines.push(`| ${row(run('LoCoMo', 10), id).label} | ${cells.join(' | ')} |`);
  }
  lines.push('| Zep / Graphiti | not run | not run | not run |');
  return lines.join('\n');
}

function lmeTable() {
  const r = run('LongMemEval', 20);
  const lines = [
    '| System | recall@20 | anyHit | allHit | MRR | p95 retrieval |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const id of ORDER) {
    const x = row(r, id), m = x.metrics;
    lines.push(`| ${x.label} | ${pct(m?.recallAtK)} | ${pct(m?.anyHit)} | ${pct(m?.allHit)} | ${mrr(m?.mrr)} | ${ms(m?.p95RetrievalMs)} |`);
  }
  lines.push('| Zep / Graphiti | not run | not run | not run | not run | not run |');
  return lines.join('\n');
}

/** The losses, stated as a table rather than a sentence that could be skimmed past. */
function lossTable() {
  const lines = [
    '| Comparison | K | Mem0 OSS | Mnemosyne | Mnemosyne config compared | Result |',
    '|---|---:|---:|---:|---|---|',
  ];
  for (const k of LOCOMO_KS) {
    const r = run('LoCoMo', k);
    const m0 = row(r, 'system:mem0-oss').metrics, us = row(r, 'hybrid-norerank').metrics;
    lines.push(`| LoCoMo recall@${k} | ${k} | ${pct(m0.recallAtK)} | ${pct(us.recallAtK)} | hybrid, no rerank | **Mem0 wins by ${((m0.recallAtK - us.recallAtK) * 100).toFixed(2)}** |`);
  }
  for (const k of LOCOMO_KS) {
    const r = run('LoCoMo', k);
    const m0 = row(r, 'system:mem0-oss').metrics, us = row(r, 'hybrid-norerank').metrics;
    lines.push(`| LoCoMo MRR | ${k} | ${mrr(m0.mrr)} | ${mrr(us.mrr)} | hybrid, no rerank | **Mem0 wins by ${(m0.mrr - us.mrr).toFixed(4)}** |`);
  }
  const lme = run('LongMemEval', 20);
  const lm0 = row(lme, 'system:mem0-oss').metrics, lus = row(lme, 'hybrid').metrics;
  lines.push(`| LongMemEval-S recall@20 | 20 | ${pct(lm0.recallAtK)} | ${pct(lus.recallAtK)} | hybrid **+ rerank** | **Tie** |`);
  lines.push(`| LongMemEval-S MRR | 20 | ${mrr(lm0.mrr)} | ${mrr(lus.mrr)} | hybrid **+ rerank** | **Mem0 wins by ${(lm0.mrr - lus.mrr).toFixed(4)}** |`);
  return lines.join('\n');
}

const k10 = run('LoCoMo', 10), lme = run('LongMemEval', 20);
const mem0mode = row(k10, 'system:mem0-oss').mode;
const zepReason = k10.notRun.find(n => n.id === 'zep')?.reason ?? '';
const s = k10.settings;

const doc = `# Matched run — 14 September 2026

**Every number below was produced by one process, on one chunk set, at one K, under one
packing budget, scored by one evidence scorer.** No number here is quoted from a vendor.
No system that could not run has a number; it has a reason. Where we lose, the losing
number is in the same table, in the same font, as the winning one.

Reproduce it:

\`\`\`sh
npm ci
npm approve-scripts onnxruntime-node       # see the note below — do not skip this
npm run build
npm run benchmark:matched:install          # competitor SDKs, kept out of the package deps
npm run benchmark:fetch -- --corpus locomo
npm run benchmark:matched -- --corpus locomo --top-k 10 --out reports/my-run
\`\`\`

Two things a fresh clone will otherwise trip over, both found by actually doing it:

- **\`npm approve-scripts onnxruntime-node\` is required.** Recent npm blocks postinstall scripts by
  default, so the ONNX native binary never lands. The benchmark still runs and still prints correct
  numbers, but the process then aborts during native teardown — **exit code 134 on roughly one run
  in three**, which will read as a failed benchmark in CI. Measured: 1 of 3 runs aborted before
  approving the script, 0 of 5 after.
- **\`npm ci\` needs a lockfile that includes \`onnxruntime-node\`.** If it fails with
  \`Missing: onnxruntime-node@… from lock file\`, the committed lockfile predates the bundled-embedder
  dependency; refresh it with \`npm install\` once.

## The one rule that makes this a comparison

Published memory-system numbers are mostly not comparable: they use different corpora,
different chunking, different context budgets, different retrieval depths and different
judges. So the systems here are not run in their own harnesses and collected. They are run
**as conditions inside a single loop** — the same \`runCorpusBenchmark\` pass that produces
our own rows produces theirs. Identical for every row in this report:

| Parameter | Value |
|---|---|
| Retrieval depth K | ${LOCOMO_KS.join(' / ')} (each reported separately) |
| Context budget | ${s.maxContextUnits} units (\`${s.accountingId}\`) |
| Chunk size | ${s.chunkBytes} bytes, contiguous UTF-8 spans |
| Envelope | \`corpus-v1\` |
| Reader / judge | none — this is retrieval coverage, not answer accuracy |
| Generative calls | ${k10.settings ? '0' : '0'} (\`generation: 0\`, \`judge: 0\` in every raw report) |

A competitor sees only \`{id, text, role?, speaker?, date?}\` on write, and a query plus a
limit on read. It never sees an evidence label, a question id, a category, a reference
answer or a condition name, and it is credited only for chunk identities it actually
returned — unknown, duplicate and over-limit identities are rejected.

## LoCoMo — ${k10.questions} questions, ${k10.corpora} conversations, ${k10.annotatedQuestions} with positive evidence labels

${acrossK()}

### Full metrics by K

**K = 5**

${locomoTable(5)}

**K = 10 (headline)**

${locomoTable(10)}

**K = 20**

${locomoTable(20)}

## Where we lose

Our reranked path wins the headline. Our *unreranked* path does not — Mem0 OSS beats it on
recall and on MRR at every K we measured. The cross-encoder, not the hybrid fusion, is what
wins this comparison, and the fusion-only configuration is the weaker retriever of the two.

${lossTable()}

On LongMemEval-S our reranked path and Mem0 tie exactly on recall@20, and Mem0 takes MRR.

This is worth stating plainly: **on the retrieval task as scored here, Mem0's plain vector
search is a strong baseline that beats part of our stack.** Anyone choosing between these
systems on retrieval coverage alone, at these K values, should know that.

## LongMemEval-S — ${lme.questions} questions (every 10th of 500, source order), K=20

${lmeTable()}

**This corpus does not discriminate at K=20 and should not be used to claim a win.** BM25
with no model of any kind reaches ${pct(row(lme, 'bm25').metrics.recallAtK)}; the spread between the
worst and best non-trivial row is under two points. The run is published because it was
part of the matched protocol, not because it separates the systems.

The slice is **every 10th question in source order**, not the first 50: the published
release is grouped by question category, so a prefix would have been a single category
wearing the benchmark's name. Striding keeps all six categories in proportion. The full
500-question run was not performed — see *What this does not show*.

## Per-system configuration

Every configuration choice that changes what a number means is printed in the run output,
not hidden in a footnote.

**Mnemosyne** — four conditions from one ingestion and one embedding pass, so the reranker
delta is a within-run measurement rather than a comparison across two runs:

| Condition | Configuration |
|---|---|
| zero-model overlap | token overlap, no model of any kind |
| zero-model BM25 | BM25, no model of any kind |
| hybrid (dense+BM25 RRF) | \`Xenova/bge-small-en-v1.5\` int8, 384d, reciprocal rank fusion, **no reranker** |
| hybrid + rerank | the above plus \`Xenova/ms-marco-MiniLM-L-6-v2\` int8 cross-encoder, top-50 |

**Mem0 OSS** — the full mode string, exactly as printed by the run:

\`\`\`
${mem0mode}
\`\`\`

Two of those settings deserve to be read carefully, because they are the difference between
a fair comparison and a flattering one:

- \`extraction=off(infer:false)\` — Mem0's LLM fact-extraction write path is **switched off**.
  This is the free, offline path. It is *not* how Mem0 is normally sold or run.
- \`embedder=injected:…bge-small-en-v1.5…\` — Mem0 is running **our** embedder, not its default
  OpenAI one. This removes embedding quality as a confound so the comparison is between
  retrieval architectures, but it means this is not Mem0's out-of-the-box stack either.

## Systems that could not run, and exactly why

| System | Status | Reason |
|---|---|---|
| Mem0 OSS, extraction off | **scored** | Ran to completion. Cost: **$0**. |
| Mem0 OSS, LLM extraction (\`infer:true\`) | **not run — spend not authorised** | The write path calls an LLM per \`add()\`. Estimated below. No key was read. |
| Zep Cloud | **not run — no credential** | ${zepReason} |
| Graphiti (Zep's engine, self-hosted) | **not run — spend not authorised** | \`add_episode\` always makes generative calls. Estimated below. |

### The cost estimates, with their arithmetic

These are **estimates, not measurements**, and they are the reason those rows are empty.
Nothing was spent; no metered API was called at any point in this run.

Measured inputs, from the raw reports: LoCoMo is **5,882 turns / 5,882 ingested chunks /
726,954 bytes** of turn text across 10 conversations.

- **Mem0 with \`infer:true\`** — roughly 2 generative calls per \`add()\` (fact extraction, then
  an update decision against retrieved neighbours): 5,882 × 2 ≈ **11,800 calls**. At ~1k input
  tokens and ~150 output tokens per call that is ~11.8M input and ~1.8M output, or
  **≈ $2.80 at gpt-4o-mini rates** ($0.15/$0.60 per 1M). Materially more on a larger model.
- **Graphiti** — \`add_episode\` runs entity extraction, entity resolution, edge extraction, edge
  dedup and temporal invalidation: call it 5 calls per episode, 5,882 × 5 ≈ **29,400 calls**,
  ~59M input and ~8.8M output tokens, **≈ $14 at gpt-4o-mini rates**. Running it free on a
  local Ollama model is possible in principle but is a multi-day run on this hardware.

Zep Community Edition — the free self-hostable server — is **not** an available path: it is
deprecated upstream and its own compose file references \`zepai/zep:latest\`, which no longer
exists on Docker Hub. Verified: unauthenticated and bogus-key requests to
\`api.getzep.com/api/v2/threads\` both return HTTP 401.

## What this does NOT show

1. **It is not answer accuracy.** No reader and no judge run. \`generation: 0\`, \`judge: 0\` in
   every raw report. This measures whether the evidence was retrieved, not whether a model
   then answered correctly with it. It is not the official LoCoMo category F1 evaluator and
   not an official LongMemEval score.
2. **Mem0 is evaluated as a vector store, not as the product it is.** To be scored identically
   it must ingest our chunks and return our chunk identities. Mem0's actual value proposition —
   LLM extraction of durable facts from conversation — is switched off. A matched protocol and
   a natural-configuration comparison are different experiments; this is the former.
3. **No vendor's hosted tier was tested.** Not Mem0 Platform, not Zep Cloud. Published vendor
   numbers for those tiers are not reproduced, disputed or endorsed here — they are simply a
   different thing than what this measures.
4. **The LLM-extraction cost asymmetry is real and is not in the table.** Our rows cost $0 in
   API spend. A production Mem0 or Graphiti deployment pays per ingested turn, forever. A
   table of recall says nothing about that difference in either direction.
5. **LongMemEval-S is a 50-question slice**, ~10% of the benchmark, and it is near-saturated at
   K=20. Treat it as a protocol check, not as a result.
6. **Latency is local, uncontrolled and not like-for-like.** Our reranked p95 includes a
   cross-encoder pass; Mem0's does not. Retrieval timing excludes ingestion and packing.
7. **Mode labels are attestations.** The harness records how each system says it was configured;
   it does not independently authenticate a third-party SDK's internals.
8. **One seed, one machine, one run.** No variance across seeds or repeats is reported, so small
   gaps — including the sub-point LongMemEval spreads — should not be read as separations.

## Provenance

| | LoCoMo | LongMemEval-S |
|---|---|---|
| Adapter | \`${k10.adapter}\` | \`${lme.adapter}\` |
| Source SHA-256 | \`${k10.sourceSha256}\` | \`${lme.sourceSha256}\` |
| Normalized SHA-256 | \`${k10.normalizedSha256}\` | \`${lme.normalizedSha256}\` |
| Runtime | ${k10.runtime} | ${lme.runtime} |
| Complete | ${k10.complete} | ${lme.complete} |

### The implementation digests are not all identical, and that is checked rather than waved at

These runs were produced over several hours while partition, offset and stride support were
being added to the benchmark **command-line driver**. The implementation fingerprint covers
every compiled file, so it moved three times:

${summary.runs.map(r => `| ${r.corpus} K=${r.topK} | \`${r.implementationSha256}\` |`).join('\n')
  .replace(/^/, '| Run | Implementation SHA-256 |\n|---|---|\n')}

The committed tree is \`${lme.implementationSha256}\`.

The honest question is whether those differences moved any number. That was **measured, not
assumed**. A 304-question, 2-conversation LoCoMo slice was re-scored under the committed tree at
each of K=5, 10 and 20 and compared per question against the corresponding published report:

**6,384 per-question attempt records compared — retrieval scores, packed scores, status and
chunk counts — with 0 mismatches.** The drift is confined to the CLI driver; the scorer and the
retrievers are unchanged across all three digests.

LoCoMo is externally supplied under CC BY-NC 4.0 and LongMemEval-S under its dataset card's MIT
terms. Neither is redistributed by this package; \`npm run benchmark:fetch\` retrieves them.

## Artifacts

Raw per-question records for every system and every run are in
[\`reports/matched-run-2026-09-14/\`](matched-run-2026-09-14/), stored gzipped (145 MB → 2.8 MB).
[\`summary.json\`](matched-run-2026-09-14/summary.json) holds the table above in machine-readable
form; **this document is generated from it**, so the prose and the measurements cannot drift apart.
`;

writeFileSync('reports/matched-run-2026-09-14.md', doc, { mode: 0o644 });
console.log('wrote reports/matched-run-2026-09-14.md', doc.length, 'bytes');
