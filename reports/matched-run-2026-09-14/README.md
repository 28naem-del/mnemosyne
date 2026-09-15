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

**Uncompressed size is 76,141,738 bytes (76.1 MB)**, against 2,944,190 bytes committed — a factor
of 25.9 — which is why these are stored gzipped. Do not retype those figures: `make-report.mjs`
reads them out of the `.json.gz` members' own ISIZE trailers every time it regenerates
`../matched-run-2026-09-14.md`, so the published report cannot drift from the files on disk.

## Regenerating the published report

Both steps run from the repository root and are the exact scripts used to produce what is
published, so the claim that the report is generated rather than hand-written is checkable:

```bash
node reports/matched-run-2026-09-14/make-summary.mjs   # merged raw reports -> summary.json
node reports/matched-run-2026-09-14/make-report.mjs    # summary.json      -> ../matched-run-2026-09-14.md
```

`make-summary.mjs` reads the uncompressed merged reports, so `gunzip -k *.json.gz` first.
