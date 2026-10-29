#!/bin/bash
# Diagnostic pass: identical to bench.mjs but Zep's response is re-sorted by its own score. Searches only, 0 credits.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; OUT="$ROOT/out/locomo-diag-scoresorted"; mkdir -p "$OUT"; cd "$ROOT"
for i in "$@"; do
  ZEP_SORT_BY_SCORE=1 ZEP_RPM=240 scripts/withkey.sh node scripts/bench.mjs locomo "$i" "$OUT" > "logs/diag-locomo-$i.log" 2>&1; echo "diag part $i exit $?"
done
cd wt; for k in 5 10 20; do node dist/evaluation/matched-benchmark.js --merge "$OUT" --corpus locomo --top-k $k > "$ROOT/logs/diag-merge-k$k.log" 2>&1; echo "merge k$k exit $?"; done
cd "$ROOT" && node scripts/gen-report.mjs "$OUT" > logs/diag-gen-report.log 2>&1; echo DIAG_DONE
