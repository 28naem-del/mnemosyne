# Gradual migration acceptance contract

Baseline: rc7 `c6a5684ca803b3827c064d3fb55113039139cb51`. The user requests an optional bridge beside an existing memory system, copying memories as used and gradually preferring Mnemosyne, while retaining full migration.

- Explicit read-only legacy adapter; constructors start no work. Existing records and legacy write paths remain untouched. Every query still reconciles legacy results; missing search results do not establish deletion.
- Genuine pre-import local recall coverage drives gradual preference. Cold matches remain available. Counter/phase progress is durable and bounded but never claims complete-store migration or automatically disconnects the legacy source.
- Stable scoped origins, exact source text, opaque revision equality validation, correction propagation, and source-state checks before committing or dispatching. Reject out-of-order asynchronous responses, local divergence and late cancelled work.
- Private untrusted defaults, explicit host-asserted observed trust, source-backed complete-envelope context budgets. Failed staging is explicit; untracked legacy text must not enter the validated agent context.
- The agent integration keeps using eligible native Mnemosyne memories during coexistence. A guarded native union must not reintroduce unreconciled imported sources, and native hits must not inflate legacy coverage.
- Rollback changes routing immediately without erasing either store; invalidates in-flight bridge packets. Privacy forgetting erases origin copies/dependents and blocks replay through both gradual and full migration.
- Default agent behavior and full migration remain regression-tested. Prove the new path with synthetic adapter usage, cold-start fallback, growing preference, restart, upstream change, erasure, upstream outage and rollback; never use live user data.
- Independent code/security review, Node 22/24 checks, strict examples and installed-package verification. Local candidate only; no publication or production deployment.

Design references: [AWS gradual replacement](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/strangler-fig.html) and [Microsoft cache-aside consistency limits](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside). These motivate preserving the old authority and explicit reconciliation; they do not certify this implementation.
