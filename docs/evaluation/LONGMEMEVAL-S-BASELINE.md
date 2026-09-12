# Public LongMemEval S retrieval baseline

This run evaluated **499 of 500** questions from the authors' cleaned LongMemEval S release, using local lexical retrieval and no external models. At **K = 20 turns**, complete labeled evidence was retrieved for **406/499 questions (81.36%)**. Mean evidence-session recall was **89.30%**, micro recall **86.79%**, and mean precision **13.70%**. The no-memory baseline retrieved no evidence.

This is a descriptive retrieval baseline. It measures neither generated-answer correctness nor semantic abstention and is not comparable to published full-dataset answer scores. Finding one turn from a labeled session does not prove that the particular answer-bearing turn was retrieved.

## Source and execution

- [Official dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned), revision `98d7416c24c778c2fee6e6f3006e7a073259d48f`; MIT license as declared by the dataset card.
- Source `longmemeval_s_cleaned.json`: 277,383,467 bytes. Full download SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` matched the repository's public LFS metadata.
- Local kernel at `16105231405f49bb0d6c27b1c1a75a29e6a73772`; evaluation adapter adds the explicit timestamp policy below. Ranking code and K/candidate settings were not tuned after inspecting results.
- Node 22.16.0; `topK: 20`, `maxCandidates: 1000`, fresh scoped SQLite per question, lexical and no-memory baselines only.
- Evaluated 23,828 positional conversation sessions and 246,354 turns in about 93.5 seconds on the local development machine. This uncontrolled timing includes parsing, indexing and querying; it is not per-query latency.
- Embedding, generation and judge calls: **0**. An independent reviewer recomputed every case's scores and the subset hash from the downloaded data.

The first ten entries were initially exercised as a development sample. They are all single-session-user questions, so that sample was not representative. The larger run includes them and is not an independent held-out experiment. Repeated upstream session IDs and their positional occurrences are preserved; scoring deduplicates IDs as the labels require.

## Explicit compatibility and exclusion

The default strict timestamp parser rejected 76 questions with 1,475 history sessions later than the stated question time. All those sessions were on the same calendar day; 75 occurrences carried evidence labels. The full supported run therefore explicitly selected `timestampPolicy: "question-day"`, making each retrieval cutoff the end of the normalized UTC question day. Original source dates were preserved. Per-case cutoffs and affected counts are in the raw report. This mode does not establish strict instant-by-instant temporal correctness.

One knowledge-update question, `852ce960` at original zero-based index **369**, was excluded before scoring because session 8, turn 0 contains **76,719 UTF-8 bytes**, exceeding the preexisting **65,536-byte** per-turn bound. The turn was not truncated or split. All 500 entries were checked; all 499 accepted entries were evaluated. Every score denominator uses only those 499 entries. This filtered coverage, day-level cutoff and turn-based K prevent a direct numerical comparison to a full-500 published benchmark.

## Where retrieval needs improvement

Complete evidence coverage by question category:

- User information in one session: **68/70 (97.1%)**.
- Assistant information in one session: **54/56 (96.4%)**.
- Preferences in one session: **20/30 (66.7%)**.
- Temporal reasoning: **102/133 (76.7%)**.
- Knowledge updates: **71/77 (92.2%)**; one additional case rejected as described above.
- Multiple sessions: **91/133 (68.4%)**.

The 30 unanswerable cases still have labeled counterevidence sessions. Retrieval returned context for all 30 and found all labeled sessions for 20. Neither number measures whether a model would correctly abstain. Low precision at K = 20 also means substantial unrelated context can accompany retrieved evidence. Future work should test selected semantic retrieval, diversity and context selection against frozen development/held-out splits, followed by separately authorized answer generation and judging with matched model budgets.

## Inspect and reproduce

The [raw report](longmemeval-s-supported499-report.json) includes every case, retrieval reference, score, effective limit and limitation. The [manifest](longmemeval-s-supported499.manifest.json) records source and subset hashes, exact exclusion, engine identity and reproduction settings. The raw conversations are not included in this repository.

Download the pinned source from the manifest and verify its full SHA-256. Remove only index 369 after asserting its question ID, retaining the remaining order and text. Serialize the resulting array with JavaScript `JSON.stringify` plus a final LF to reproduce the subset hash. Then run:

```sh
mnemosy evaluate --file /absolute/path/to/supported499.json --limit 20 \
  --json '{"timestampPolicy":"question-day","maxCandidates":1000,"maxQuestions":500,"maxDatasetBytes":536870912,"timeoutMs":600000}' \
  --out /absolute/path/to/new-report.json
```

Read the [adapter protocol](../LONGMEMEVAL.md) before interpreting these metrics. Future scoring changes must retain this historical report rather than silently rewriting it.
