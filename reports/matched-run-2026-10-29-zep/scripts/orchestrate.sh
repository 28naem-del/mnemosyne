#!/bin/bash
# Runs bench.mjs for each LoCoMo conversation once phase 1 reports it processed (one bench at a
# time, so latency is not measured under self-contention), then merges parts and builds tables.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/out/locomo"; mkdir -p "$OUT" "$ROOT/logs"
cd "$ROOT"
done_list=" "
while :; do
  pending=0
  for i in 0 1 2 3 4 5 6 7 8 9; do
    case "$done_list" in *" $i "*) continue;; esac
    pending=1
    f="state/prep-locomo-$i.json"
    [ -f "$f" ] || continue
    if grep -q '"status": "processed"' "$f"; then
      echo "$(date -u +%FT%TZ) bench part $i"
      ok=0
      for attempt in 1 2; do
        if ZEP_RPM=240 scripts/withkey.sh node scripts/bench.mjs locomo "$i" "$OUT" > "logs/bench-locomo-$i-try$attempt.log" 2>&1 \
           && [ "$(grep -c 'complete=true' "logs/bench-locomo-$i-try$attempt.log")" = 3 ]; then ok=1; break; fi
        echo "$(date -u +%FT%TZ) bench part $i attempt $attempt not clean"; sleep 60
      done
      echo "$(date -u +%FT%TZ) bench part $i ok=$ok"
      done_list="$done_list$i "
    elif grep -q '"status": "failed"' "$f"; then
      echo "$(date -u +%FT%TZ) part $i failed in phase 1; skipping"; done_list="$done_list$i "
    fi
  done
  [ "$pending" = 0 ] && break
  sleep 30
done
cd wt
for k in 5 10 20; do node dist/evaluation/matched-benchmark.js --merge "$OUT" --corpus locomo --top-k $k > "$ROOT/logs/merge-k$k.log" 2>&1; echo "merge k$k exit $?"; done
cd "$ROOT" && node scripts/gen-report.mjs "$OUT" > logs/gen-report.log 2>&1; echo "gen-report exit $?"
echo ORCHESTRATE_DONE
