# Raw artifacts — matched run, 2026-09-14

Every number in `../matched-run-2026-09-14.md` comes from these files. Nothing here
is hand-edited; they are the exact output of `npm run benchmark:matched`.

| File | What it is |
| --- | --- |
| `summary.json` | The headline table, derived from the merged reports. The published report is generated from this, never typed by hand. |
| `locomo-k5.json.gz` | LoCoMo, K=5, all 1,986 questions, every system. |
| `locomo-k10.json.gz` | LoCoMo, K=10 — the headline K. |
| `locomo-k20.json.gz` | LoCoMo, K=20. |
| `longmemeval-stride10-k20.json.gz` | LongMemEval-S, K=20, every 10th question in source order (50 of 500). |

Each report carries, per question and per system, the retrieved and packed evidence
scores, the chunk counts, retrieval latency, the settings block, the corpus digest,
and the implementation digest of the code that produced it.

```bash
gunzip -k locomo-k10.json.gz
node -e 'const r=require("./locomo-k10.json");console.log(r.summaries.hybrid.meanRecall)'
```

The per-part intermediates (`*-part*.json`) are not committed: a merged report already
contains every attempt record from its parts, and `mergeParts` refuses to combine parts
whose settings, corpus digest, embedding identity, system roster or implementation
digest differ, so the merge cannot silently blend different experiments.

**Uncompressed size is 145 MB**, which is why these are stored gzipped (23x).
