# rc7 acceptance contract

Baseline: `1b5df481981035f0576f285155ba2c28b48b50fd` (rc6). Define acceptance before implementation. All fixtures use synthetic or explicitly supplied public data; live user memories are outside the test scope.

- Host integration: a single host turn automatically recalls, captures and schedules bounded work. Two distinct client identities demonstrate privacy, sharing, correction, restart/replay and erasure. Action execution rechecks the exact evidence and arguments immediately before callback entry. Background work is opt-in, bounded, cancellable and recoverable from existing durable job leases.
- Adaptive context: long histories produce a context packet within the declared accounting budget, with progressive exact-source access. Summary/cached selections lose eligibility after source correction, deletion, failed outcomes or freshness changes. No hidden model calls or untracked source caches.
- Migration: new profiles follow verified primary export contracts. Exact source bytes, explicit ownership, untrusted defaults, replay, guarded undo and privacy forgetting work through the existing lifecycle. Unknown native semantics remain clearly reported rather than silently promoted.
- Agent evaluation: one shared reader and equal per-condition budgets, isolated memory instances, repeated trials and counterbalanced condition order. Expected answers and grading labels never reach memory/reader callbacks. Report task accuracy, unsupported answers, stale actions, negative transfer, context cost, errors and latency separately. Deterministic demonstration results are never labeled real-model superiority.
- Regression: existing public exports, Node 22/24 behavior, Python client, source retention, policy, dispatch, installed package and fresh-client Docker simulation remain valid.
- Release: independent code/security review, focused fixes followed by relevant regression checks, build and isolated package verification. No automatic publication or production deployment.

Research inputs: current primary LongMemEval/LongMemEval-V2 protocols, Mastra observational memory, and the rc6 competitor comparison. These inform implementation and experiments; they are not proof that this implementation reproduces another system's results.
