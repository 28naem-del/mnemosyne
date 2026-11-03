# Threat model

This page describes the threats the local memory kernel and the release process are built against, and the limits of what has been measured. It does not add claims. Every number below is copied from a report or guide already in this repository. A poisoning result is zero escapes on a named suite, and nothing more. Consolidation is outcome-gated and reversible. The corpora and ledgers named here are synthetic. Recorded experience is not weight-level learning.

The operational boundaries in [SECURITY.md](SECURITY.md) still apply: workspace and agent identifiers are controller selectors, not authentication, and a model speaking to the MCP server cannot change its workspace, raise its own trust, or record its own skill trials.

## What is in scope

- The local SQLite kernel (`createLocalMemory`) and the transports that serve it: TypeScript SDK, MCP, CLI and authenticated HTTP.
- How a record's trust label, scope and provenance affect default recall, compile, list, promotion, correction and forgetting.
- Outcome-gated consolidation and the signature on its receipts, on the 3.0 pre-release.
- The path from a git tag to the npm tarball, including Actions, the lockfile and the release SBOM.

## Memory poisoning

The adversarial suite asks whether planted, laundered, leaked or forgotten content can reach an agent through the local kernel. It runs offline, on the lexical path, with no network, no model and no API key, one fresh store per case, and a fixed clock. The corpus is 227 synthetic cases (167 attacks, 60 benign controls), seed `poisoning-v1`, sha256 `4b5d665d881b4bbcf0152733a8a51e98c19671f03539d9742d514ae6240ee336`, byte-identical to the seeded generator. Classes and the promotion rule are in [docs/POISONING-SUITE.md](docs/POISONING-SUITE.md). The case file is described in [benchmarks/poisoning/README.md](benchmarks/poisoning/README.md).

| Mode | Attack escapes | False quarantines | Errors | Source |
|---|---:|---:|---:|---|
| Default (`npm run poisoning`) | 0 / 167 | 0 / 60 | 0 | [reports/poisoning/v1/report.md](reports/poisoning/v1/report.md) |
| Consolidation on | 0 / 167 | 0 / 60 | 0 | [reports/poisoning/v1-consolidation/report.md](reports/poisoning/v1-consolidation/report.md) |
| Ungated negative control | 85 / 167 | 0 / 60 | 0 | [reports/poisoning/v1-consolidation/ungated-control/report.md](reports/poisoning/v1-consolidation/ungated-control/report.md) |

The consolidation-on run recorded 294 gate decisions: 11 kept, 184 rolled back by invariant, 99 `no_evidence`, and 0 laundering passes kept. The ungated control applies passes the gate did not keep, and its 85 escapes are content 30, selection 24 and path 31. That control shows the probes can see laundered content. It is not a measurement of a deployed attacker.

Switching off one kernel guard at a time, in a scratch copy of `dist`, made every mutant fail the gate. Examples recorded in [docs/POISONING-SUITE.md](docs/POISONING-SUITE.md): 71 escapes without untrusted-exclusion, 22 without agent scope, 13 path escapes and 11 errors without the candidate ancestry check. The full mutant table is in that guide.

What that zero does not mean, as stated in [docs/BENCHMARKS-TRUST.md](docs/BENCHMARKS-TRUST.md) and [docs/POISONING-SUITE.md](docs/POISONING-SUITE.md):

- It is not resistance to attacks outside these 227 cases.
- The content and selection classes test the trust-label gate, not content inspection. The kernel does not scan text for injected instructions. A record written as `observed` is served as observed. Trust is decided by channel and provenance.
- Only the lexical path is exercised. Dense and hybrid retrieval are not covered, and the consolidation gate replays lexically.
- In consolidation mode the synthetic verifier counts any non-empty recall as a success, so the suite does not exercise regression rollback (0 regression rollbacks). The zero-escape result rests mostly on the invariants. 99 of 294 passes had too few judged tasks to be scored (`no_evidence` is not a keep).
- `import()` accepts a hand-built snapshot's trust label when the record has no dependencies. The suite does not test that as an attack. Import is an operator path.
- A failed outcome removes a record from compiled context but not from recall.
- Decaying quarantine is not implemented. A quarantined candidate stays `untrusted` until a later promotion succeeds.
- Ancestry-disjoint provenance is not independence in the world. Two sources with different URIs and authors that copied the same upstream text count as disjoint. The rule only sees provenance that was recorded.
- An uncited paraphrase built only from trusted tokens can be kept. That case is not defended.
- SDK writes default to `untrusted`. CLI and MCP writes default to `observed`. Neither label certifies that a claim is true ([docs/quickstart.md](docs/quickstart.md)).

## Provenance and trust

Records carry a trust tier chosen by the controller: `untrusted`, `observed` or `verified`. Default retrieval excludes `untrusted` records. Evidence fields, reassuring text and a distinct verifier id do not authenticate the underlying claim. Prompt boundaries and schema validation do not guarantee immunity to prompt injection. Action checks validate complete declared local dependencies at dispatch. They do not lock an external system or replace its authorization ([SECURITY.md](SECURITY.md)).

Promotion (`ancestry-disjoint-v1`) raises trust only when the candidate is eligible, every dependency is already at the target trust, and at least two active corroborators of that trust share no provenance ancestor with the candidate or with each other. Ancestors are traced over dependencies, supersession, invalidation source, source URI and author. A grant supersedes the candidate instead of editing it in place. Every decision, granted or quarantined, is a `promotion` ledger event. The rule and its known gaps (opaque corroborator ids left after erasure, no decaying review) are in [docs/POISONING-SUITE.md](docs/POISONING-SUITE.md).

Corrections cascade through declared dependencies. Undeclared dependencies can be inferred from successful co-use and proposed for review. On dependency suite v1, a synthetic corpus (seed 20261028, 120 corrections, accept-all eval reviewer), invalidation recall is 96.05 % (170/177), precision of accepted edges is 98.06 % (152/155), and the premise guard held every stale procedure in that run (0 stale executions). Inference alone left 7 of 248 checks stale, and the guard's false-hold rate is 92.78 %. Those figures cover that synthetic corpus. They do not show that every undeclared premise in a real trace will be found ([docs/DEPENDENCIES.md](docs/DEPENDENCIES.md), [docs/BENCHMARKS-TRUST.md](docs/BENCHMARKS-TRUST.md)).

Consolidation, on the 3.0 pre-release, is a signed diff replayed against the agent's own recorded outcomes. It is kept only when aggregate lexical coverage on that replay set does not drop and no invariant breaks. A kept pass that nothing has changed since can be undone. The state hash is identical only when nothing was written after the pass. The gate is off in the standard MCP setup. The host turns it on from the SDK ([docs/CONSOLIDATION.md](docs/CONSOLIDATION.md)).

A consolidation signature shows that the holder of the private key for that `keyId` signed the assertion. It does not prove that the gate ran, that the proposals are true, or that the outcome improvement generalizes beyond the recorded replay set. Anyone who can write the database and holds the key file can re-sign the chain. The signing key is a `0600` file beside the database, not inside a plain backup. An encrypted backup can carry it. The threat table for forged diffs, replay, tail truncation and key pinning is in [docs/CONSOLIDATION-SIGNING.md](docs/CONSOLIDATION-SIGNING.md). The fixed seed key used by the poisoning suite is public by construction and must not sign a real store.

Forgetting removes covered live content and blocks replay of known source identities. It cannot erase old exports, backups, copied prompts, external logs, swap or physical remnants. Restoring an older backup cannot contain tombstones created after that backup ([docs/OPERATIONS.md](docs/OPERATIONS.md)).

Databases and plain whole-database backups are plaintext. `--encrypt` bundles are passphrase-encrypted with AES-256-GCM and a scrypt-derived key ([SECURITY.md](SECURITY.md), [docs/OPERATIONS.md](docs/OPERATIONS.md)). Backup checksums and SQLite integrity checks detect corruption. They are not signatures or sender authentication. The HTTP service binds bearer credentials to configured scopes and defaults to loopback. Remote TLS and enterprise identity are deployment work.

Optional local models are downloaded only when requested, at a pinned commit, and each file is checked against a pinned SHA-256 digest before use ([docs/LOCAL-MODELS.md](docs/LOCAL-MODELS.md)).

## Supply chain

- npm dependencies are pinned by `package-lock.json`. CI runs `npm ci --ignore-scripts` and `npm audit --omit=dev --audit-level=high`. Dependabot opens weekly update pull requests for npm and for GitHub Actions.
- Workflow actions are pinned to full commit SHAs. Dependabot can bump those pins. A moving tag is not a pin.
- The publish workflow checks the tag against `package.json`, packs one tarball, installs that tarball, and publishes that same file with npm provenance. It also requests `id-token: write` and still passes `secrets.NPM_TOKEN` as `NODE_AUTH_TOKEN`. Removing the long-lived token requires npm trusted publishing to be confirmed by the owner. This repository's workflow cannot prove that setting by itself. See issue #66.
- Before MCP Registry publication, the workflow verifies the `mcp-publisher` archive with cosign against the upstream release identity.
- On a successful publish, a later job generates a CycloneDX SBOM from the tagged tree (Syft, via `anchore/sbom-action`) and uploads it as a workflow artifact. If a GitHub Release for that tag already exists, the job attaches `mnemosy-ai-<version>.cdx.json`. The workflow does not create the GitHub Release. Scorecard's SBOM check looks at release assets whose names end in `.cdx.json` (or SPDX names) on the latest releases, and at a matching file in the repository root. No SBOM file is committed here, so the check stays empty until a release asset is attached.
- The product image (`Dockerfile`) uses `node:24-alpine` by tag. The optional legacy compose services use floating image tags. Those tags are not digest-pinned.
- Optional model weights are not part of the npm package.

Passing CI, a provenance attestation, or an SBOM does not establish that the kernel resists every threat or that a dependency is free of vulnerabilities outside the audit level that ran.

## Out of scope

- A process that can already read the database file or run as the same operating-system account. Filesystem permissions are the boundary. The kernel is not a sandbox against that process.
- Attacks that are not in poisoning suite v1, including dense or hybrid retrieval, and hand-built snapshot imports that carry an `observed` label and no dependencies.
- Remote TLS, organizational identity, hosted synchronization and model training. Those are not in this release.
- Weight updates. Nothing here is described as learning in that sense, or as general intelligence.
