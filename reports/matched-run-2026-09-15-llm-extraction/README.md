# Raw artifacts — matched run, 2026-09-15 (Mem0 LLM extraction)

Every number in `../matched-run-2026-09-15-llm-extraction.md` comes from these two reports.
Nothing is hand-edited; they are the exact output of `run-matched-mem0-llm.mjs`, and every
table in the published report is the stdout of `make-tables.mjs`, pasted.

| File | What it is |
| --- | --- |
| `locomo-partA-k10.json.gz` | Part A raw report — LoCoMo conversation 0, 10 of 19 sessions, 215 turns, 104 questions, K=10, every system. |
| `locomo-partB-k10.json.gz` | Part B raw report — LoCoMo conversation 1, 11 of 19 sessions, 212 turns, 57 questions, K=10, every system. |
| `make-parts.mjs` | Derives both parts from the licensed corpus. The corpus itself is CC BY-NC 4.0 and is not redistributed here. |
| `run-matched-mem0-llm.mjs` | The runner that produced the raw reports. |
| `make-tables.mjs` | Regenerates every table in the published report from the two `.gz` files. |

Each report carries, per question and per system, the retrieved and packed evidence scores,
the chunk counts, retrieval latency, the settings block, the corpus digest, the embedding
identity, and each system's mode string.

```bash
node reports/matched-run-2026-09-15-llm-extraction/make-tables.mjs   # reads the .gz files directly
gunzip -k locomo-partA-k10.json.gz                                   # if you want the raw JSON
node -e 'const r=require("./locomo-partA-k10.json");console.log(r.summaries["system:mem0-oss-llm"])'
```

## Why two parts instead of one full-corpus run

Mem0's `infer:true` write path makes one LLM call chain per `add()`, sequentially, at a measured
1.86 s per chunk blended over the two parts. The full 5,882-chunk corpus would take ≈ 3 h 2 min of
wall clock — beyond this job's budget — for ≈ $4.27, which was well inside the authorised ceiling.
The limit was time, not money.
The published report says so in the same words.

## Reproducing the parts

```bash
npm run benchmark:fetch -- --corpus locomo    # CC BY-NC 4.0, not redistributed here
node reports/matched-run-2026-09-15-llm-extraction/make-parts.mjs --out /tmp/parts
```

A part is whole sessions in session order up to a turn budget, keeping only the questions whose
every evidence turn survived the cut — so a missed hit is a retrieval miss, never a corpus artefact.

The rebuilt files are **not byte-identical** to the ones this run consumed: the originals were
serialised with spaces after the JSON separators, and this script writes compact JSON. They are
deep-equal, and the harness's normalised digest — the one pinned inside each raw report — matches:

| Part | Normalized corpus SHA256 |
| --- | --- |
| A | `689b45320e1f2afbc1f4ca14d61b93d18d777868793c4fbbb2bcc8bdcc616530` |
| B | `6f552bc646a834b0099e435af581b479842476f5129d7f5fc890fed4ee9a5146` |

## Rerunning the scored run

`npm run benchmark:matched` refuses `--mem0-extraction llm`: the shipped command is wired to no key,
which is what stops an unattended benchmark from billing anyone. `run-matched-mem0-llm.mjs` supplies
the LLM configuration explicitly and changes nothing else — same adapter, same harness, same options.

```bash
OPENROUTER_API_KEY=… node reports/matched-run-2026-09-15-llm-extraction/run-matched-mem0-llm.mjs \
  --file /tmp/parts/locomo-partA.json --top-k 10 --out /tmp/partA.json
```

It reads the key from the environment only. The key is in no argument, no log, and no file here.
Each part cost ≈ $0.15 and took ≈ 7 minutes.
