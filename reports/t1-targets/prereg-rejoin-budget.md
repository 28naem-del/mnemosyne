# T1.7 pre-registration — context-budget lever (rejoin lead, written 2026-10-15 ~23:45, BEFORE any budget pass)

Frozen reader config (unchanged, from evidence/t17/frozen-config.md): `--reader-prompt v4_stacked --pass-as-of
--date-format weekday --order rank`, reader anthropic/claude-sonnet-4.6, judge anthropic/claude-haiku-4.5,
judge prompt + scorer unchanged. Only the context byte budget is varied here.

Why: findings/rejoin-t17-misses.md — of the 24 dev misses at 8192, 6 lost complete gold evidence to the 8192
packing step (exact minimum budgets 8306 .. 16659); all 7 dev-with-part questions lacking complete evidence at
8192 are currently wrong; no gain beyond 24576.

Dev split: the same 100 ids (evidence/t17/dev-100-ids.txt, source index i%10 in {0,2}). Retrieval source:
retrieval-500/parts-131072 (K=20, all hits recorded), re-packed by the driver's --budget (re-pack at 8192 is
byte-identical to a native 8192 report: evidence/u2-repack-oracle.txt, evidence/t17/driver-budget-repack-verify.txt).

Reference arm: 8192 = evidence/t17/runs/dev-v4_stacked_weekday.json, 76/100 (not re-paid).
Candidate arms (one paid dev-100 pass each): 24576, then 16384.

Decision rule (fixed now): adopt the budget with the highest dev judge accuracy among {8192: 76, 16384, 24576};
ties go to the smaller budget. McNemar vs the 8192 arm is reported but is not the selection criterion.
The chosen config then runs ONCE on the full 500 in one session; report judge accuracy with Wilson 95% CI,
exact-match alongside, and the HOLDOUT-400 (exclude dev ids) number. No further reader/prompt changes after this.
Stop rule: no other dev pass is started for the budget lever.
