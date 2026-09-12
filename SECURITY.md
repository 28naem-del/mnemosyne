# Security policy and boundaries

This branch is the 2.0.0-rc.1 release candidate. Security-related breaking changes are described in [migration notes](docs/MIGRATION-v2.md). A passing test suite or dependency audit is not a security certification.

## Report a vulnerability

Use the repository's existing private contact, [team@mnemosy.ai](mailto:team@mnemosy.ai), with the subject `[SECURITY]` and a short description. Include affected version, reproduction, impact, and a minimal proof of concept. Do not include real credentials, private memories, or another person's data in a public issue.

## Trust model

- The SDK runs inside a trusted controller. Workspace/agent IDs are selectors chosen by that controller, not login credentials or tenant authentication.
- Anyone who can read the SQLite database or its snapshots can access their content. The package provides no encryption, remote identity provider, or isolation from privileged local processes.
- Memories are fallible reference data. A stored instruction never creates authority to run a command, send a message, or change access. Prompt wrapping and schema validation reduce accidental misuse; they cannot guarantee model compliance against every injection.
- Verified trust and successful outcomes are controller assertions. The package requires evidence fields but cannot authenticate their contents. MCP models cannot promote themselves, record successful outcomes, import snapshots, or commit reflection.
- Sharing is explicit. Do not give an untrusted caller a controller SDK handle or a backend administrator credential. Run separate processes/databases where stronger isolation is needed.
- Model providers are selected by caller code. Reflection is bounded and signals cancellation, but cannot stop billing or work at a remote service that ignores that signal.

## Deletion and copies

Local forgetting removes live content and dependent content from the kernel's records, versions, search entries, outcomes, audit/retry payloads. It does not purge old exports, backups, copied prompts, logs outside the kernel, swap, or physical storage remnants. Qdrant forgetting checks scope and erases explicit points; graph/cache copies elsewhere are not a distributed erasure guarantee. Cache revalidation prevents stale records from being returned through the tested recall path.

## Verification

CI runs tests, package checks, and dependency auditing. Tests use isolated local databases and mocked Qdrant/graph transports unless explicitly labeled otherwise. Keep live infrastructure tests separate from production data. Never use shared production volumes for destructive test fixtures.
