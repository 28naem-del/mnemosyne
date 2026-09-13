# Engineering review and open gaps

This ledger records implemented behavior, reproducible evidence and remaining work for the 2.0.0-rc.8 source candidate. It complements [release status](UPGRADE-STATUS.md) and the executable protocols; it is not an independent security certification or a claim of comparative product superiority.

## Findings and disposition

| Area reviewed | Change or verified behavior | Still to establish |
|---|---|---|
| Retrieval evaluation | Separate corpus, questions and private labels; all-500 LongMemEval adapter; explicit no-memory, full-history, overlap and BM25 conditions; packed coverage and timing. | Generated-answer quality, representative held-out tasks and live competitor comparisons. |
| Lexical ranking | Scope-aware BM25 is the default after a paired comparison; overlap remains explicit for compatibility. | Broader workload and scale measurements of the new default. |
| Semantic retrieval | Full authorized indexed-corpus scanning replaces a recent-record candidate window; optional pinned CPU embeddings and reranking run through isolated processes. | Matched semantic quality measurements and a scope-correct ANN design. |
| Temporal correction | Context accepts independent validity and knowledge time; correction causes persist so historical and scheduled changes can be projected without reviving ambiguous invalidations. | Reconstruction of every mutable field transition and finer assertion-level temporal semantics. |
| Skill promotion | Candidate requirements persist; the recommended policy requires two distinct tasks and two verifier identities, while the compatibility default remains one of each. Failed prerequisites or trials retire skills. | Independent evidence supplied by a real host verifier; labels alone do not prove independence. |
| Evidence retention | A diagnostic measures valid retention separately from obsolete exposure and checks actual compiled context. | Unrelated source edits can still retire correct guidance; alternative sufficient evidence is unsupported. |
| Integration surfaces | SDK, MCP, HTTP, CLI, Python, explicit event/tool adapters and export importers are implemented. | Six validated native framework integrations; generic protocol support is not equivalent coverage. |
| Operations | Scoped bearer credentials, revocation, explicit authority controls and consistent backup/restore are available. | Built-in encryption, enterprise identity and bidirectional synchronization. |
| Distribution | Candidate versions align; exported modules and installed artifacts have verification paths. | GitHub source, npm and PyPI publication are separate release actions. |

## Paired retrieval evidence

The [corpus report](evaluation/BENCHMARKS.md) retains 500 attempts and scores positive evidence retrieval on 470 annotated answerable questions. Complete annotated-session coverage at 20 chunks improves from 386/470 with overlap to 425/470 with BM25; after identical packing, from 367/470 to 382/470. On the recorded host, p95 retrieval was approximately 4.1 ms and 15.7 ms respectively. Host load was not controlled, and these timings are observations rather than service guarantees.

Both conditions use an 8,192-byte context budget. The 30 abstention questions have no positive retrieval score; the full-history control reports 500 overflows. The run uses same-day compatibility because the source data includes 1,475 sessions later than the stated question instant. It is not a strict no-future temporal experiment. A chunk earns session-level credit even if it omits the answer-bearing sentence. No embedding, generation or judge calls were made.

The [reproduction protocol](evaluation/CORPUS_PROTOCOL.md) records the dataset revision, input hashes, executed implementation fingerprint, bounds and label separation. The earlier 499-question evaluator explicitly retains overlap semantics; its historical denominator and turn treatment must not be conflated with the new all-500 result. Local CPU smoke tests establish functioning integration, not semantic benchmark superiority.

## Evidence lifecycle evidence

The identical synthetic [evidence diagnostic](evaluation/EVIDENCE-PROTOCOL.md) compares a starting engine with the reviewed candidate. Candidate compiled context passes 15 probes, fails one and reports no unsupported-operation errors; expected-valid retention is 19/20. No obsolete IDs appear in that candidate fixture output. The failing contact-only source edit remains visible because conservatively retiring correct advice is a real cost.

These are controller-authored fixtures with a separate oracle. They cover correction, time, conflicts, failed procedures, forgetting and scope, but are not a representative deployment workload. Citation identity checks validate the referenced record, source and trust marker; they do not prove semantic entailment. Raw retrieval remains a record-inventory control, not action-safe guidance.

## Interpretation and attribution

A retrieval coverage score cannot be compared directly with a generated-answer score from another implementation. Meaningful comparisons require the same data split, reader model, context allowance, failure accounting and grading protocol. The [matched agent harness](AGENT-EVALUATION.md) provides that experiment interface; shipping the interface is not a completed model study.

The corpus adapters accept caller-acquired datasets and preserve provenance. LoCoMo's source data is CC BY-NC 4.0 and BEAM's is CC BY-SA 4.0; neither is relicensed by this MIT project. The adapters retain source answer and rubric fields separately where applicable, including disagreements, and do not claim generic exact matching is official benchmark scoring. See the [dataset manifest](evaluation/corpus-manifest.json) and [third-party notices](../NOTICE.md).

Temporal provenance, retrieval fusion and model-assisted memory are established ideas. Mnemosyne's implementation and measured behavior should be evaluated on their own evidence. This candidate does not establish AGI, exclusive invention of third-party methods or models, or a guaranteed adoption outcome.
