# Repository report audit — 2026-09-12

Read-only GitHub review covered all 4 issues, 17 pull requests, and 24 issue comments visible through the API. There were no PR reviews or review threads. Twelve items were open remotely. This document describes local changes; it does not claim the remote items have been closed or merged.

## Human reports

- [#21: RRF score dilution](https://github.com/28naem-del/mnemosyne/issues/21): fixed. Hybrid fusion preserves cosine relevance independently of ranking. Tests verify 0.94 survives fusion and factory recall; keyword-only hydration and weak-match filtering are covered too.
- [#22: keyword startup and 500-record cap](https://github.com/28naem-del/mnemosyne/issues/22): fixed using awaited paginated startup, configurable 50,000-per-collection default cap, and explicit readiness/truncation status. Failed indexing rejects initialization. The contributor's progressive background-startup proposal is not implemented; bounded awaited startup is the chosen alternative.
- [#18: research discussion](https://github.com/28naem-del/mnemosyne/issues/18): evaluated as research input. [ATANT](https://arxiv.org/abs/2604.06710) and its [companion evaluation paper](https://arxiv.org/abs/2604.10981) motivate separating persistence, correction, and disambiguation from retrieval. Their author-reported scores are not Mnemosyne results. The local lifecycle tests cover these properties in explicit fixtures; no ATANT evaluation was run.
- [#19](https://github.com/28naem-del/mnemosyne/issues/19): closed, empty issue titled '.', without actionable content.

## Dependency pull requests

- [#9](https://github.com/28naem-del/mnemosyne/pull/9), [#10](https://github.com/28naem-del/mnemosyne/pull/10), [#13](https://github.com/28naem-del/mnemosyne/pull/13): incorporated through Node types 25.5+, ioredis 5.10.1+, and TypeScript 6.0.2+. TypeScript's major update passes the local typecheck; broader runtime validation is recorded separately.
- [#11](https://github.com/28naem-del/mnemosyne/pull/11), [#12](https://github.com/28naem-del/mnemosyne/pull/12), [#20](https://github.com/28naem-del/mnemosyne/pull/20): superseded by Vitest and coverage 5.0.0.
- [#14](https://github.com/28naem-del/mnemosyne/pull/14), [#15](https://github.com/28naem-del/mnemosyne/pull/15), [#16](https://github.com/28naem-del/mnemosyne/pull/16): superseded by picomatch 4.0.7, Vite 8.3.0, and uuid 14.0.2 in the checked dependency tree.
- Historical #1–#3 were merged; #4–#8 were closed as superseded. No unresolved human review comments were present.

Dependabot also repeatedly reported nonexistent labels `dependencies` and `ci`. Those optional label declarations are removed from configuration rather than creating remote labels as a side effect.

## Independent repair loop

Additional reviewed defects included query-based erasure, graph text bypassing scoped hydration, stale cache after another instance deletes a record, unsafe raw maintenance exports, lost snapshot retry identity, asymmetric snapshot limits, stale reflection proposals after negative outcomes, ambiguous checkpoints, and candidate starvation behind failed evidence. Each has a targeted regression and a focused independent recheck. The Qdrant regressions use mocked transports; live Qdrant/graph conformance remains a separate validation task.
