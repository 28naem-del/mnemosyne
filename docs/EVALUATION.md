# Evaluation evidence — 2026-09-13

This release separates correctness checks, public-data retrieval measurements and memory-quality claims. No paid model calls, generated-answer evaluation or matched competitor experiments were performed.

## External-review follow-up on the rc8 source candidate

The reviewed source now passes **1,133 tests in 56 files on Node 22.16.0 and Node 24.21.0**, source/example typechecking and build. The Python client passes **9 tests on Python 3.12.13**, both from source and after an offline wheel install into an isolated environment. These are local results; remote CI and publication are separate steps.

The new [corpus protocol and paired report](evaluation/BENCHMARKS.md) retain all 500 LongMemEval S questions, with positive retrieval metrics on 470 answerable questions. Scoped BM25 improves complete annotated-session retrieval from 386/470 to 425/470; after identical context packing, from 367/470 to 382/470. All 499 earlier v1 overlap selections and scores reproduce unchanged under that explicitly pinned legacy scorer. The 100,000-record timings below are historical overlap measurements, not measurements of the new BM25 default.

An executable [evidence lifecycle diagnostic](evaluation/EVIDENCE-PROTOCOL.md) now measures retention and stale exposure, including known failures. Independent review reproduced and verified temporal-cause, future-effective correction, checkpoint privacy, persisted skill promotion and local model process-isolation fixes. It found no remaining blocker in the reviewed scope. Optional local CPU embedding and reranking ran together successfully against synthetic memories with cached offline weights; this establishes integration, not answer accuracy.

The base production dependency audit reports zero known vulnerabilities. A separate clean optional-model install exposed an older transitive image-processing dependency; the [documented consumer override](LOCAL-MODELS.md) selects the patched release and the optional-install audit now also reports zero known vulnerabilities. A startup guard checks the dependency actually resolved by the inference runtime before loading it. The measured frozen benchmark engine predates this provider-only guard; the retrieval and evaluation code are unchanged.

Semgrep found no issues in 17 changed/new source files and three supplemental JavaScript/Python targets. The later dependency helper and worker passed an additional two-file scan with no findings or parse errors. A pre-existing TypeScript partial-parse warning remains in the wider scan; its compiled equivalent scanned without errors. Snyk could not run without authentication. The [briefing audit](EXTERNAL-REVIEW.md) keeps unimplemented capabilities and unmeasured claims explicit.

## Verified rc7 local source checkpoint

The rc7 source passed **948 tests in 45 files on both Node 22.16.0 and Node 24.21.0**, source/example typechecking and build. The unchanged Python client passed **8 tests each on Python 3.10.19 and Python 3.13.12**. New coverage exercises host turns and SDK events, durable replay protection, bounded background work, adaptive context and exact-source expansion, complete generation-state validation, typed profiles, four additional migration profiles, operator backup/restore, a matched-reader experiment harness and packaged command-line workflows.

Independent review found and verified fixes for stale nested summaries, incomplete dependency capture, incorrect transfer scoring, model-claimed usage, background versus per-drain budgets, durable backup publication, profile schema handling and replacement ordering. Context replacement now uses fresh generation identities after retirement, including policy A → B → A and invalidated-predecessor cases. Profiles reject direct or transitive use of their own prior projection before dispatch, preserve conflicts/unknown fields and withhold stale values. No actionable findings remained in the reviewed changes.

The dependency audit reported zero known vulnerabilities. Semgrep applied the security-audit rules to **118 source, script and example files** with zero findings. Two rules that initially timed out completed in a focused rescan with no findings or errors. One existing partial parse warning remains on a type-only export in `src/local/index.ts`. Snyk was attempted on the new modules and source tree but could not run without authentication; this is not a completed Snyk check.

The new [matched experiment](AGENT-EVALUATION.md) example completed 36 scripted reader invocations over four conditions and three trials with zero external model calls. It validates isolation, updates, erasure, scoring and budget plumbing. It is not a real-model performance score, an official public benchmark result or a competitor ranking. The prior public retrieval measurement below is unchanged. The source checkpoint is distinct from the separately recorded final-package, clean-client/Docker simulation and publication state.

README/site checks covered 123 local/repository links and eight desktop/mobile page combinations, including demo controls and documentation anchors. No JavaScript errors or horizontal overflow were observed in those checks. The website is still a local candidate until publication is authorized.

## Verified rc6 local readiness checkpoint

The rc6 source passed **703 tests on Node 22.16.0 and 24.21.0**, source/example typechecking and build. The Python client passed **8 tests each on Python 3.10.19 and 3.13.12**. New coverage checks source-bearing job history erasure, invalidation before provider dispatch, legacy HTTP redirect rejection, command-line policy enforcement and the shared package verifier.

Independent reviewers reproduced and checked fixes for retained private text in failed/retried jobs, callbacks receiving a source after deletion or correction, redirects forwarding backend credentials or embedding text, and restrictive CLI flags being silently ignored. Checks include imported sources, hidden dependent jobs, guarded rollback, historical retrieval and process-boundary command execution. These tests use synthetic data and do not make paid model calls or alter production memory.

CI and publishing now use one installed-artifact verifier covering every declared export and type file, the installed executable, version agreement, tarball integrity and both deterministic demonstrations. A local whole-source Semgrep scan applied 22 matching security rules to 92 files with zero findings; its existing partial parse warning on a type-only export remains. The full dependency audit reports zero known vulnerabilities. Snyk was attempted but remains unavailable without authentication. Local results are separate from remote CI, publication and live-provider validation.

## Verified rc5 local checkpoint

The rc5 source passed **580 TypeScript tests on Node 22.16.0 and 24.21.0**, plus source/example typechecking and build. New coverage includes 15 exact JSON parser tests, 44 migration planning tests, 60 migration service tests, 14 kernel rollback tests, 25 freshness/read-set tests and 51 migration/health CLI subprocess tests.

Independent review exercised raw UTF-8 fidelity, duplicate-key and numeric handling, canonical replay, private scope, quarantined records, byte accounting, atomic failures, source tombstones after restart and snapshot restoration, and rollback against later hidden dependents or outcomes. CLI probes found and fixed a SQLite sidecar collision that could delete a supplied export, validation that opened a database before rejecting missing arguments, and previews that produced an unreadably large saved plan. Those cases now have regression coverage.

Freshness review tested stale asynchronous confirmations, cancellation before callback entry, one deadline including preflight, failed check evidence, clock reversal, tampered action bindings and a full 2,048-record dependency chain. A repaired traversal removes repeated per-ancestor eligibility scans. These are local mechanism checks, not evidence of general reasoning or agent-task gains.

An offline-installed rc5 package passed **14 entry-point imports**, package/CLI/MCP version agreement, both existing demos (14 and 13 checks) and all five runtime/native-provider/migration/maintenance examples. The new examples use temporary databases, exact source bytes, process reopenings, a simulated clock and scripted probes; zero model calls are made. Website docs/features were rendered at 1440×1000 and 390×844 with no observed horizontal overflow; navigation and copy controls passed browser checks.

Dependency audit reported zero known vulnerabilities. Semgrep applied 22 matching security-audit rules to 14 changed/new source targets with zero findings; it retained a partial-parse warning on the existing type-only re-export in `src/local/index.ts` (approximately 99.9% parsed). Snyk was attempted on the new modules and examples but remains unauthenticated. Remote CI is recorded separately in the pull request. No actual user's memory was migrated, no live competitor account was connected, and the historical public retrieval baseline below is unchanged.

## Verified rc4 local checkpoint

The rc4 source passed **371 TypeScript tests** on Node 22.16.0 and 24.21.0, source/example typechecking and build. Its 45 virtual-engine tests and 20 provider-wrapper tests cover shared generic provenance, existing Claude compatibility, completed-call validation, exact provider IDs, optional/null differences, correlated errors, policy, correction, forgetting and retries.

Independent review also created a database using the actual installed rc3 package, then reopened it with the new engine. Notes, a large blank file and replay receipts remained unchanged. Cross-provider IDs stayed distinct, and host-loop fixtures preserved original history, returned failed tool results and avoided empty final Gemini result turns. An offline-installed rc4 package passed all 12 import checks, both demos and both native protocol examples. These examples use synthetic provider envelopes and zero external model calls.

Semgrep applied 22 matching security-audit rules to the five adapter/example source files with zero findings and no parse errors. Snyk was attempted and remains unauthenticated. Provider network/model sessions are untested; remote CI results are recorded in the pull request. The historical public retrieval baseline below is unchanged.

## Verified rc3 local checkpoint

The rc3 source passed **342 TypeScript tests** on Node 22.16.0 and 24.21.0, source/example typechecking and build. This includes 36 native memory adapter tests and 19 LongMemEval adapter tests. An offline-installed package imported all **12** tested entry points, passed both recorded demos and executed the native correction/retry/deletion example with zero model calls. Package, CLI and MCP versions were checked for agreement; CI now enforces that agreement.

Independent review checked native command parsing, scope, source lifecycle, blank-byte preservation, transaction rollback, concurrent connections, policy changes and durable receipts. The new-code Semgrep scan applied 22 matching security-audit rules to five TypeScript files with zero findings and no parse errors. Snyk was attempted again and remains unavailable because the account is unauthenticated. These are local results; remote CI is recorded separately in the pull request.

The [public cleaned LongMemEval S baseline](evaluation/LONGMEMEVAL-S-BASELINE.md) ran 499 supported cases with explicit day-level compatibility and one pre-scoring size rejection. Its raw source hash and all case/aggregate metrics were independently checked. It provides retrieval evidence and identifies gaps; it does not measure answer accuracy.

## Verified rc2 checkpoint

The September 12 rc2 checkpoint passed **304 TypeScript tests** on both **Node 22.16.0 and Node 24.21.0**, plus source/example typechecking and build. The Python standard-library HTTP client passed **8 tests**. Dependency audit reported **0 known vulnerabilities**. A fresh offline-installed package imported all 11 tested entry points and ran the 14-check memory demo and 13-check learning demo. Python-to-Node integration additionally exercised capture, correction, history, forgetting and replay rejection against the actual loopback service. CI includes both Node versions, Python 3.10/3.13, installed-package checks and the executable SDK example; configured CI is distinct from a completed remote run.

Independent review exercised kernel, runtime, transport, provider, connector, branch, relation and website boundaries. Repairs include correction during asynchronous retrieval, historical graph projections, concurrent model publication, source-content restoration, delayed extraction, analysis-channel exclusion, and capture-disabled HTTP writes. Browser checks covered the live inspector's correction/forget/disconnect behavior and the recorded learning cycle at desktop and phone widths.

Snyk Code scanning was attempted but could not run because the local account is unauthenticated. Semgrep ran 99 security-audit rules on 82 first-party source targets with 0 findings. It reported one partial-parse warning at a TypeScript type-only re-export in `src/local/index.ts`; approximately 99.9% of lines parsed. This is not a completed Snyk scan. Docker/Compose execution and live production backend conformance were not tested; the Compose plugin was unavailable. These limitations remain despite passing local tests.

The earlier rc1 checkpoint passed 173 tests and remote Node 22.16/24 CI. Those historical results do not substitute for verification of rc2.

## Correctness and integration

The original 62 tests passed before the reported defects were fixed. The upgrade adds regression coverage for those missing cases and for the new lifecycle. Current tests cover source corrections, descendant invalidation, private/shared scopes, conflicting facts/checkpoints, bounded context, outcomes, snapshot roundtrips and retry identity, simultaneous local connections, reflection validation/cancellation, and real MCP stdio sessions.

Qdrant/graph/Redis regressions use in-process mocked transports. They test request construction, ownership, score handling, response errors, cache revalidation, maintenance guards, and private broadcast routing. They do not establish live service compatibility under production load.

`npm run check` typechecks and builds before running tests, so MCP subprocess tests execute the current CLI. CI targets Node 22.16 and 24. The six-step executable demo makes 14 assertions against isolated real SQLite records, including opening a new agent connection and correcting the brief. The website reads that recorded run; it does not invoke an LLM.

`npm run demo:learning` runs a second isolated real-SQLite demonstration: exact capture and replay, a scripted source-cited observation job, an inactive candidate, two controller-executed trial cases, explicit workspace publication, a second agent's recall, cross-workspace isolation, transitive correction, original-source inspection, forgetting and replay blocking after reopening. Its **13 checks** and two passing trial cases are integration evidence. The proposer is a hand-authored fixture; zero LLM calls are made. The website's second recording exposes both successful and failed or unrun checks.

## Synthetic scale probe

Run `npm run benchmark -- --count 10000 --queries 100 --out NEW_FILE.json`. Counts are bounded at 100,000 records. The runner writes deterministic SKU facts to a temporary file-backed SQLite database with per-record transactions and WAL, performs 100 exact-ID queries and 20 broad queries, then removes its temporary database. It does not simulate a crash or certify crash durability.

The following historical rc1 measurements were observed on macOS arm64, Node 26.4.0, on September 12. Background host load and cold/warm cache states were not controlled. These are single-process exploratory measurements, not latency guarantees:

- **10,000 records:** ingestion 1.345 seconds; exact-ID hits@5 100/100, p50 0.033 ms, p95 0.115 ms; broad-query p50 130.858 ms, p95 158.908 ms.
- **100,000 records:** ingestion 16.375 seconds; exact-ID hits@5 100/100, p50 0.040 ms, p95 1.890 ms; broad-query p50 1464.238 ms, p95 1933.133 ms.

[10k raw measurement](evaluation/local-10000.json) and [100k raw measurement](evaluation/local-100000.json) preserve the measured values. Their original kind label mentioned durability; that label has been corrected because no crash experiment was conducted.

### rc2 retrieval regression and repair

The added temporal filters initially caused SQLite to scan the workspace's records before its term postings. A new query groups indexed term matches before loading their records; scope, time, outcome and provenance checks remain applied. A paired 20,000-record probe improved both exact and broad queries, and the unchanged 100,000-record runner then measured:

- **100,000 records:** ingestion 63.086 seconds; exact-ID hits@5 100/100, p50 0.135 ms, p95 0.332 ms; broad-query p50 371.807 ms, p95 411.906 ms.
- Before the query repair, rc2 exact-ID p95 was 256.751 ms and broad-query p95 was 1780.928 ms. The regression is retained in the work log; no faster result is substituted for a failed run.

[The rc2 raw measurement](evaluation/local-rc2-100000.json) includes runtime, platform, workload and limits. Host load and cache state remain uncontrolled. Ingestion was slower than rc1 because rc2 maintains an additional term-posting index; retrieval improvements do not imply faster writes. These figures are not service-level guarantees or a comparison with another memory product.

Broad lexical queries still examine posting lists and synchronously load matching candidates. SQLite work can block its process. Hybrid retrieval adds explicitly selected embeddings and bounded candidate processing, but brute-force local vector comparison is not an approximate-nearest-neighbor index. These probes do not establish semantic answer quality, distributed load capacity or agent task improvement.

### Write cost and compact posting storage

A [paired 20,000-record investigation](evaluation/ingestion-rc2-20000.json) confirmed the write-cost change: rc1 took 2.234–2.239 seconds and rc2 took 10.546–10.797 seconds. Omitting posting maintenance in a temporary diagnostic copy brought it to 2.274 seconds; that diagnostic omission was not shipped. The fixture produced 300,000 term postings.

New posting tables now use SQLite's `WITHOUT ROWID` layout with the same composite key, reverse term index and foreign-key cascade. The paired database sizes decreased from roughly 80.1 MB to 61.8 MB. Existing tables remain supported without rebuilding or migrating them. Latency improvement from the compact layout was noisy, so no speed gain is claimed. The 100,000-record timing above predates this storage-layout change.

With the original rc2 layout, explicit atomic batches of 500 records took 5.269–5.283 seconds for the same 20,000 records, versus 10.354–10.403 seconds with independent per-record commits. Batching changes the commit boundary; it is not an equivalent durability workload. The default cache, WAL checkpoint, synchronous durability, secure deletion and foreign-key settings remain unchanged. Runtime capture and the evaluation importer already use bounded atomic batches.

## Offline dataset evaluation path

The new [LongMemEval v1 adapter](LONGMEMEVAL.md) accepts an explicitly supplied dataset file and runs isolated no-memory and lexical baselines, with optional selected embeddings. It measures evidence-session recall, precision and coverage; answer correctness and semantic abstention remain unevaluated. The runner strips reference answers, turn labels and evidence-marked identifiers from indexed data, uses deterministic ordinal record IDs, and records raw-file hashes, effective candidate windows and provider budgets.

Nineteen synthetic adapter tests cover label leakage, metrics, stable ties, BOM fingerprints, cancellation, multi-batch deadlines, bounds and cleanup. The extra timestamp-policy fixtures distinguish strict instants from explicit question-day cutoffs. Two additional CLI tests cover file output and no-provider operation. No official dataset or external model was used for those checks. This is an executable evaluation path, not a published LongMemEval score.

A subsequent [public cleaned S retrieval baseline](evaluation/LONGMEMEVAL-S-BASELINE.md) evaluated 499 of 500 cases and retrieved complete labeled evidence for 406/499 at K = 20 turns. The full source hash was verified; the exact oversized-turn exclusion and question-day compatibility mode are documented with raw results. An independent reviewer recomputed every score. These are retrieval metrics with zero model calls, not answer accuracy or a comparison to other systems.

## Agent experiments still required

Freeze task splits and source/agent/model revisions before tuning. Compare no memory, a strong plain-file or summary baseline, and each enabled memory mechanism using the same model and compute allowance. Evaluate held-out tasks; do not tune abstention on test labels.

Measure completed task outcomes, stale-advice reuse after correction, negative transfer, scope leakage, unsupported assertions, context cost, latency, and handoff recovery. Include withheld and failed cases. Score answer correctness separately from evidence retrieval. Validate against the official protocols for [LongMemEval](https://github.com/xiaowu0162/LongMemEval) and [LoCoMo](https://github.com/snap-research/locomo) before publishing a benchmark claim. Use real independent task outcomes for reflection instead of repeatedly treating the same model's self-assessment as new evidence.

The design hypothesis is that explicit provenance, scope, correction, and bounded experience reuse improve continuity. Its general agent-performance benefit remains unmeasured.
