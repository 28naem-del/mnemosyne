# Mnemosyne Evidence Gate

Mnemosyne keeps candidate skills separate from reusable advice, then checks evidence again before a host action. Context supported by stale, conflicted, untrusted, failed or missing sources can be withheld. A high retrieval score alone does not establish eligibility.

## Earn promotion through trials

Select `RECOMMENDED_SKILL_PROMOTION_POLICY` to require successful trials across **two distinct tasks and two verifier identities**. A candidate stays outside advisory context until its stored gate is satisfied. The compatibility default remains one task and one verifier; the stronger policy is explicit. Each candidate retains its promotion requirements, and reopening with a weaker configuration does not lower them. Task and verifier identities are controller assertions, not independent verification: the host must provide real tests and verify that its evidence is independent. The [runtime constructor example](/docs/reference/RUNTIME.html#project-models-skill-trials-and-traces) shows how to select the recommended policy.

## Bind the intended action

`MemoryAgent.prepareAction()` binds the action name, arguments, memory dependencies and a short validity period. The host declares that the dependencies are complete. `executeAction()` revalidates immediately before dispatch and rejects invalid or replayed plans. Corrections, erasure, changed outcomes, expired confirmations and packet tampering can invalidate a plan.

## Require current confirmation where needed

The host defines source watches through [Memory Freshness](/docs/reference/MAINTENANCE.html). Requiring watched evidence means the declared dependency chain must have current confirmations. An unwatched source is not automatically fresh, and an external document is not fetched just because a gate was created. Supply meaningful source checks through a trusted host adapter.

## Keep the boundary clear

The gate checks recorded local evidence at dispatch time. It does not grant action permission, discover omitted dependencies, lock an external service or guarantee the truth of a source. The host still owns authorization, downstream version checks and idempotency. [Evaluation](/docs/#evaluation) separates deterministic lifecycle checks from model answer quality and broader task outcomes.
