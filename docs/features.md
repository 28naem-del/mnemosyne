# Features and boundaries

## Portable local memory

The local engine persists records, outcomes, corrections, provenance, and task state in SQLite. WAL, transactions, prepared statements, input limits, and explicit scope selectors support multiple local connections. Scope identifiers are selected by a trusted controller; they are not authentication against another process that can read the database file.

## Correction-aware experience

An explicit correction supersedes the original and invalidates dependent records, transitively. Sharing a lesson cannot make its private evidence public. Different active texts with one explicit fact key remain a conflict. Arbitrary natural-language contradictions without a shared key are not automatically detected.

## Budgeted context

`compile` returns a rendered evidence envelope with source citations. Use `packet.text` as the bounded model input. Raw record/diagnostic fields are outside that budget. The default counter counts UTF-8 bytes conservatively; provide the target model's tokenizer to measure tokens precisely. With insufficient space the engine withholds an entire conflict group instead of silently choosing a winner. Failed or conflicted source chains withhold derived recommendations.

## Continuity and outcomes

Checkpoints preserve task goals, completed and pending work, constraints, decisions, artifacts, rejected approaches, and next action. Declare source or procedure dependencies to retire the handoff when they are corrected; failed evidence is excluded from resume. Conflicting shared task state throws `CheckpointConflictError` on resume and makes task compilation abstain. A trusted controller can record outcomes, which affect retrieval scoring and context eligibility. Outcome evidence is an assertion supplied by the caller, not a built-in test runner or cryptographic attestation.

## Bounded reflection

`reflect` makes zero calls without eligible evidence and at most one proposer call otherwise. It enforces input/output byte budgets, proposal count, timeout, and cancellation signaling. It rejects fabricated source IDs, exact duplicate content, and invalid output. It never writes. `commitVerifiedLesson` checks independent controller validation and source revision/outcome consistency before storing an observed lesson. It does not train model weights or prove that a model's proposed generalization is correct.

## Existing vector backend

`createMnemosyne` retains Qdrant-backed vector/hybrid recall, optional graph/Redis integrations, and existing cognitive helpers. This release repairs score handling, keyword-only hydration, startup index coverage, authenticated/time-bounded requests, collection isolation, nondestructive fact handling, and scoped maintenance. Historical exported modules and configuration flags should not be interpreted as proof that every research feature runs automatically. Read [migration](MIGRATION-v2.md).

## Outside this release

No hosted synchronization, encrypted storage, semantic local embeddings, autonomous background reflection, automatic cross-engine migration, universal agent compatibility claim, or verified public-benchmark score is included. An MCP-capable client can invoke the tools; individual clients still need integration testing.
