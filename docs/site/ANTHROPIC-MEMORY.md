# Mnemosyne Memory Tools

Let an agent view and maintain virtual text files backed by scoped Mnemosyne memory. File content, revisions and source dependencies live in the local database. The `/memories` path is a virtual namespace, not access to a physical directory. The host chooses its transport and model; executing a memory command does not itself call a model.

## Bind an authorized scope

The host sets the workspace, agent, namespace, session and permissions outside model-controlled command input. Scope selectors are not authentication. Ordinary viewing and writing follow the host's configured policy, while deletion needs an explicit grant. Existing namespace identities remain stable across upgrades and retries.

## Text operations

Commands can view, create, replace exact text, insert lines, rename and delete virtual files. Before editing an existing file, the session must have observed its current revision; a conflicting edit requires a fresh view. Paths are constrained to the virtual namespace. Commands cannot execute code, alter provider configuration, select another owner or certify a fact as verified.

## Evidence and replay

Model-authored notes are untrusted by default and do not become ordinary advice merely because they were saved. The host can mark witnessed text as observed. Edits correct the source and invalidate dependent advice. Trusted operation identities make mutation retries idempotent without retaining old text in replay receipts.

## Deliberate boundaries

Privacy deletion removes live source content and dependents; it cannot erase earlier model messages, exports or backups. The host still owns streaming assembly, protocol identity and loop limits. [Shared Memory Tools](/docs/reference/PROVIDER-TOOLS.html) describes multi-transport use of the same scoped engine.
