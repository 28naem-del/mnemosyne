# T1.7 (lane t17) frozen configuration, chosen on dev-100 only

## Dev-100 results (all four pre-registered in `evidence/t17/prereg-dev100.md` BEFORE any pass ran)

| pass | reader prompt | asOf | date format | order | judge acc | exact | McNemar vs baseline (66/100) |
|---|---|---|---|---|---:|---:|---|
| baseline (stored, $0, REPORTED from accuracy-250.json rows) | shipped | off | n/a | n/a | 66/100 (66.0%) | 5/100 | n/a |
| 1. dev-v3_both | v3_both | on | iso | rank | 72/100 (72.0%) | 5/100 | +10/-4, p=0.1796 |
| 2. dev-v4_stacked_iso | v4_stacked | on | iso | rank | 75/100 (75.0%) | 5/100 | +12/-3, p=0.0352 |
| 3. dev-v4_stacked_weekday | v4_stacked | on | **weekday** | rank | **76/100 (76.0%)** | 6/100 | +11/-1, p=0.0063 |
| 4. dev-v4_stacked_weekday_chrono | v4_stacked | on | weekday | **chronological** | 72/100 (72.0%) | 6/100 | +10/-4, p=0.1796 |

All VERIFIED (this lane ran every pass and recomputed every number from the raw output with
`reports/t1.7-accuracy/analyze.mjs`; raw outputs under `evidence/t17/runs/*.json`, analyses under
`evidence/t17/runs/*.analysis.json`).

## Decision (stopping rule from the pre-registration, applied honestly)

Each lever was stacked on top of the previous, in the order fixed BEFORE any pass ran:
1. asOf + abstention counterweight (v3_both): 66 -> 72 (+6).
2. + knowledge-update recency, counting/enumeration, preference-grounding (v4_stacked): 72 -> 75 (+3).
3. + weekday-consistent date rendering (`--date-format weekday`): 75 -> 76 (+1).
4. + chronological evidence ordering (`--order chronological`): 76 -> **72 (-4)**.

Pass 4 made things WORSE on this dev slice (reported honestly, as required -- this is a measurement
that "failed", not one that is hidden). Per the pre-registered stopping rule, the lane freezes the
best of the four passes: **pass 3**.

**Frozen configuration: `--reader-prompt v4_stacked --pass-as-of --date-format weekday --order rank`**
(no `--budget`: not tested on dev-100, because the dev retrieval report was never built at a budget
larger than 8192; the budget lever is deferred to the full-500 confirm below, per job brief WORK
item 7).

`--order rank` is the driver's DEFAULT, so it does not need to appear on the command line, but it is
spelled out below for clarity and to make plain that `--order chronological` was tried and rejected,
not merely omitted.

### Why reorder for chronological order despite the loss

The dossier's lever-6 estimate was the smallest and most tentative ("+1 to +3 on 250, possibly within
noise"); losing 4 net rows on a 100-question slice is well inside what a single stochastic reader
pass can produce (the judge/reader are not perfectly deterministic even at temperature 0 and a fixed
seed -- see the `06f04340` case below). The lane does NOT conclude chronological ordering is harmful
in general; it concludes only that, measured once on this dev-100 slice, it did not help and the
pre-registered stopping rule says not to chase it further without re-measuring on more data than this
lane's budget allows. The lead may choose to re-test `--order chronological` on the full 500 as an
OPTIONAL fifth configuration if the $ budget allows (see job brief: this lane's job is to freeze a
configuration and hand off the exact confirm command, not to exhaust every combination).

### A reproducibility caveat worth recording

Question `06f04340` (single-session-preference) was `reader-invalid-json` in pass 3 (the shipped
adapter's `parseLeadingJsonObject` correctly rejected a reply with no parseable JSON object -- not a
parser bug, see `evidence/t17/ledger.md`-adjacent raw row in `runs/dev-v4_stacked_weekday.json`) but
`completed` with a different (also judge=false) answer in pass 4, on an otherwise byte-identical
prompt and context modulo the chronological reorder. Reader determinism at temperature 0 / fixed seed
is not perfect through OpenRouter; a handful of rows can flip between any two passes for reasons
unrelated to the lever being tested. This is a real source of noise the dev-100 McNemar tests already
account for (they compare paired outcomes, not raw totals), but it means a repeat of pass 3 or pass 4
would not reproduce row-for-row, only in aggregate within sampling noise.

## Full-500 confirm: exact commands for the lead

Precondition: `<job-dir>/retrieval-500/parts-131072/longmemeval-k20.json`
must exist (the lead's merge of all stride-1 500-question parts built with `--max-context-units 131072`).
Run this lane's `--mock` check FIRST ($0, no network) to prove 500/500 byte-exact rebuilds before
spending anything, exactly as the dossier recommends:

```bash
cd <tree containing this lane's committed reports/t1.7-accuracy/* and built dist/, e.g. this clone
   the T1.7 lane>
node reports/t1.7-accuracy/run-accuracy-gate.mjs \
  --retrieval <job-dir>/retrieval-500/parts-131072/longmemeval-k20.json \
  --corpus benchmarks/data/longmemeval_s_cleaned.json \
  --mock --budget 8192 --out /tmp/mock-full500-8192.json
# expect: "completed": 500 and no thrown Context-rebuild-mismatch error
node reports/t1.7-accuracy/run-accuracy-gate.mjs \
  --retrieval <job-dir>/retrieval-500/parts-131072/longmemeval-k20.json \
  --corpus benchmarks/data/longmemeval_s_cleaned.json \
  --mock --budget 16384 --out /tmp/mock-full500-16384.json
```

Then the paid confirm, budget 8192 (frozen config; ~$5.3 list at 8 KB per the dossier's cost table,
scaled from this lane's measured ~$1.11 per 100 questions at 8 KB x 5):

```bash
source <job-dir>/bin/or-env.sh
node reports/t1.7-accuracy/run-accuracy-gate.mjs \
  --retrieval <job-dir>/retrieval-500/parts-131072/longmemeval-k20.json \
  --corpus benchmarks/data/longmemeval_s_cleaned.json \
  --provider-config reports/t1.7-accuracy/openrouter.json \
  --judge-config reports/t1.7-accuracy/openrouter-judge.json \
  --pass-as-of --reader-prompt v4_stacked --date-format weekday --order rank \
  --budget 8192 --variant-label full500-confirm-8192 \
  --out reports/t1.7-accuracy/full500-confirm-8192.json
```

As a second option, budget 16384 (same command, `--budget 16384 --variant-label full500-confirm-16384
--out reports/t1.7-accuracy/full500-confirm-16384.json`; ~$9 list per the dossier's estimate, scaled
~2x reader input tokens). The job brief says the lead chooses the budget on dev-100 once the full-500
report exists -- this lane's driver supports either without further code changes; it did not pay for
a budget pass itself.

### Post-run analysis commands (read the gate; $0)

```bash
# Full 500, Wilson 95% CI, exact-match alongside, abstention accounting, per-type breakdown:
node reports/t1.7-accuracy/analyze.mjs --run reports/t1.7-accuracy/full500-confirm-8192.json

# HOLDOUT-400 only (the uncontaminated number -- the complement of this lane's dev-100 ids):
node reports/t1.7-accuracy/analyze.mjs --run reports/t1.7-accuracy/full500-confirm-8192.json \
  --exclude-ids evidence/t17/dev-100-ids.txt

# Paired McNemar vs the shipped-prompt baseline, if the lead also runs one full-500 baseline pass
# (OPTIONAL, ~$5 per the dossier; this lane did not run it):
node reports/t1.7-accuracy/analyze.mjs --run reports/t1.7-accuracy/full500-confirm-8192.json \
  --baseline <a full-500 shipped-baseline run-accuracy-gate.mjs output>
```

### Gate arithmetic (for reference, from the dossier, re-stated here)

Point estimate passes the plan's gate at >= 400/500 (80.0%). The Wilson-95%-lower-bound reading of
the gate needs >= 418/500 (83.6%). This lane's dev-100 number (76.0%) is a biased-high estimate of
the full-500 number only in the sense that the dev slice composition differs from the full set's
(dev-100 baseline 66.0% vs the stored 250's 71.2%, i.e. dev-100 is HARDER than average by about 5
points on the shipped prompt) -- so if the +10-point lift holds proportionally on the full,
harder-average set, the full-500 point estimate would land near 81%, clearing the point-estimate gate
but likely not the Wilson-lower-bound reading. This is an extrapolation, not a measurement; only the
full-500 confirm settles it.
