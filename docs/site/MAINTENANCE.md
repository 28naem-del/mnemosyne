# Mnemosyne Memory Freshness

A fact can become outdated without a new message contradicting it. `MemoryMaintenance` tracks explicit source-check policies and the last accepted confirmation, helping an agent distinguish current evidence from material that needs review. Age alone never changes a fact's text, trust or historical validity.

## A clock and a source policy

The host chooses which sources need checking and how often, then supplies evidence for each check. A confirmation starts a new freshness interval. Reading a memory does not renew it. The service distinguishes fresh, stale, changed, unavailable and unchecked states; an unwatched source is not the same as a verified source.

## What a check means

`confirmed` records support for the current assertion; `changed` flags a source change; `unavailable` means verification could not establish the state. None invents a replacement fact. A submitted check is bound to the source and previous check state so a delayed result cannot override a newer correction or check. Confirmation remains a host assertion, not authenticated factual truth.

## Run bounded checks

`health.scan()` inspects local status. `health.probeDue()` runs a supplied probe under explicit count, deadline and cancellation limits. The host provides scheduling and source access. Ordinary retrieval does not automatically acquire these policies: use the freshness-aware path or an [evidence gate](/docs/reference/EVIDENCE-GATE.html) where current confirmation is required.

## Recheck the evidence behind an action

An action read set binds exact memory dependencies and check state to the proposed operation. Validate it immediately before dispatch; correction, erasure, changed checks or expiry can invalidate it. This is a point-in-time check of local evidence, not an authorization grant or a transaction that locks an external system.
