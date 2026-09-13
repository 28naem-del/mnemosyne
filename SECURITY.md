# Security policy

Mnemosyne 2.0.0-rc.8 is a release candidate. Review [migration notes](docs/MIGRATION-v2.md) before upgrading existing applications. Report security issues affecting this candidate or an earlier version with the exact affected version; fixes are evaluated against the current development line. There is no published long-term-support guarantee or security certification.

## Report a vulnerability privately

Email **[28naem@gmail.com](mailto:28naem@gmail.com)** with a subject beginning `[SECURITY] Mnemosyne`. Include the affected version or commit, expected and observed behavior, reproduction steps, impact and a minimal proof of concept using synthetic data. Do not disclose an unpatched vulnerability or put credentials, private memories or someone else's data in a public issue.

## Controller and access boundaries

The TypeScript SDK runs inside a trusted controller. Workspace and agent IDs select records; they are not login credentials, tenant authentication or protection from a process that can read the database. Give untrusted callers a constrained transport interface, not a controller SDK handle. Use separate processes or databases where stronger isolation is needed.

The HTTP service binds bearer credentials to configured scopes and supports revocation and separate capture, recall and destructive-operation controls. It defaults to loopback. Remote TLS, identity management and deployment perimeter controls are application responsibilities. Keep token files private and outside version control. MCP authority is fixed at launch: models cannot choose arbitrary identities, claim verified trust, report successful trials or import snapshots.

Memories are fallible reference data. Stored instructions do not authorize commands, messages, access changes or other actions. Verified trust, source confirmation and successful trials are controller assertions; evidence fields and distinct verifier IDs cannot authenticate the underlying claims. Prompt boundaries and schema validation do not guarantee immunity to prompt injection. Action checks validate complete **declared** local dependencies at dispatch; they do not lock an external system or replace its authorization.

## Storage, backups and erasure

The local database and whole-database backups are **plaintext**. Anyone able to read them can access their contents, including private records and multiple workspaces. Protect storage permissions and use deployment-level encryption where required. Backup checksums and SQLite integrity checks detect corruption; they are not signatures, encryption or sender authentication. Restore goes to a new path and does not perform a service cutover.

Local forgetting removes covered live content, correction history and dependent payloads, and uses tombstones to block replay of known source identities. It cannot erase old exports, backups, copied prompts, external logs, swap or physical storage remnants. Restoring an older backup cannot contain tombstones created after that backup. Maintain an appropriate recovery and deletion process. See [operations](docs/OPERATIONS.md).

The existing Qdrant path performs scoped explicit-point erasure and recall cache revalidation. Other graph, cache or exported copies are not covered by a distributed erasure guarantee. Do not test destructive behavior against a production database or shared volume.

## Providers and dependencies

The host explicitly chooses providers, endpoints and processing budgets. Timeout and cancellation signals cannot stop work or billing at a remote service that ignores them. Optional local model provisioning downloads selected artifacts only when requested; cached inference can run offline. Follow the pinned runtime, patched dependency and license requirements in [LOCAL-MODELS.md](docs/LOCAL-MODELS.md).

CI runs correctness, packaging and dependency checks. Most integration tests use isolated databases or mocked transports unless labeled otherwise. Passing them does not establish production isolation, semantic correctness or security against every threat. Preserve dependency notices and report new vulnerabilities through the private contact above.
