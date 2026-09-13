# Evidence lifecycle diagnostic

```sh
npm run build
npm run benchmark:evidence -- /absolute/path/to/new-report.json
```

This runs controller-authored synthetic source changes against fresh temporary databases. It checks relevant corrections, valid historical guidance, delayed knowledge, unrelated field changes, independent dependency branches, identical reingestion, expiration, unresolved conflicts, failed procedures, erasure and private scope boundaries. No live store or external model is used.

The raw-retrieval and compiled-context conditions receive identical events. Raw retrieval is a diagnostic record inventory, not an action-safe system or a reproduction of a competitor. Compiled context is checked by parsing its actual model-visible text and comparing it with returned records and citations. Citation identity precision validates the record, source URI and trust marker; it does not prove that a claim is entailed by the source.

Retention is compared with an external oracle that never enters memory. For example, changing only a contact name should not invalidate an unchanged timeout rule. The current conjunctive dependency model conservatively retires that rule; the diagnostic deliberately reports this as a failure. It does not quietly relabel the valid rule obsolete to obtain a perfect score. Alternative independent support is explicitly unsupported rather than counted as a success.

Unresolved conflicting facts can remain visible with a conflict notice while being ineligible as action guidance. That is not counted as retirement. Erasure checks both search and direct historical reads. Historical context remains subject to current access and deletion boundaries.

Each report records individual outcomes, errors, valid retention, unjustified retirement, obsolete exposure, citation identity validity, fixture-text hash and the executed harness hash. Errors make retirement/citation rates unavailable; missing retention remains a failure. The engine revision can be recorded with `MNEMOSYNE_EVAL_ENGINE_REVISION=<full-git-sha>` and is explicitly caller-supplied. For a paired comparison, run the identical compiled evaluator beside frozen engine builds; relative imports select that build's implementation.

These fixtures diagnose behavior and test the evaluator itself with deliberate rendering/citation faults. They are not a representative held-out benchmark, model answer accuracy, or proof of AGI.

## Paired result, 2026-09-13

The identical compiled evaluator ran beside the frozen starting engine and the reviewed source candidate. Compiled context improved from 9 passing probes, 1 failure and 6 unsupported-operation errors to 15 passing probes, 1 failure and no errors. Expected-valid retention improved from 12/20 to 19/20; no obsolete IDs appeared in the candidate's compiled context. The remaining failure is the contact-only change described above. Passing these fixtures does not establish zero stale actions in a real agent.

The broader raw-retrieval inventory remains a diagnostic control and exposes a failed procedure; applications needing eligible guidance should use compiled context and validate dependencies before acting. Its results are retained rather than presented as action-safe behavior.

[Starting engine report](reports/evidence-lifecycle-before.json), [candidate report](reports/evidence-lifecycle-after.json), and [engine/report hashes](evidence-manifest.json) preserve every probe. The engine manifest records the compiled JavaScript files, including the identical evaluator, and identifies the base Git revision and uncommitted candidate status.
