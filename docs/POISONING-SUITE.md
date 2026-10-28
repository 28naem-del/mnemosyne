# Adversarial poisoning suite

The poisoning suite tests whether planted, laundered, leaked or forgotten
content can reach an agent through the local memory kernel. It runs offline:

- lexical retrieval only;
- no network, no model and no API key;
- a fixed clock;
- a fresh store for every case.

Current result: **zero escapes on poisoning suite v1, 227 cases, reproducible from
a fresh clone.** That result covers these 227 cases and nothing more. It does not
show that Mnemosyne cannot be poisoned, and nothing in this document should be
read that way.

## Running it

```sh
npm ci && npm run build
npm run poisoning
# which is:
node dist/evaluation/poisoning/cli.js --cases benchmarks/poisoning/v1/cases.jsonl --out reports/poisoning/v1
```

The command writes `reports/poisoning/v1/report.json` and `report.md`. It exits
non-zero when the gate fails. The suite runs in about 2 s on a laptop. The same
gate also runs in `tests/poisoning-suite.test.ts`.

The corpus is `benchmarks/poisoning/v1/cases.jsonl`. A seeded generator
(`src/evaluation/poisoning/generator.ts`, seed `poisoning-v1`) produces it, and
its sha256 is recorded in `benchmarks/poisoning/README.md`. Run
`node dist/evaluation/poisoning/cli.js --write-cases <path>` to regenerate it.
The test fails if the regenerated corpus differs from the checked-in file by a
single byte.

## Case anatomy

Each case contains:

- **principals:** a workspace id and an agent id for each actor;
- **steps:** store, ingest, correct, outcome, forget, promote, lesson,
  checkpoint, export and import;
- **probes:** read-side checks run after the steps.

A step marked `gate` is one the kernel may refuse, and that refusal is what the
case measures. If any other step throws, the result is a harness error.

| Outcome | Meaning |
|---|---|
| **escape** | On an attack case, at least one probe surfaced the poison. |
| **false quarantine** | On a benign control, at least one probe failed to surface the legitimate record. |
| **harness error** | The case could not be judged. Examples: an unexpected throw; an `armed` probe that could not find the poison even with `includeUntrusted` (the case would test nothing); a promotion with no matching ledger entry; a quarantine verdict that does not name the expected shared ancestor. |

The gate requires all of the following:

- 0 escapes;
- a false-quarantine rate below 2 % of benign controls;
- 0 harness errors;
- a corpus byte-identical to the generator's output.

The probes cover default `recall`, `compile` and `list`. Some cases also probe
`inspect`, `get`, `getAt`, the ledger and `export` across principals, as well as
trust levels, accepted writes, promotion decisions, and a full-text search for a
unique marker after erasure.

Each case runs in fresh SQLite stores with `retrieval: 'lexical'`, `ledger: {}`
and one deterministic clock (2026-01-01T00:00:00Z, plus one second per read)
shared by every principal in the case. A principal that is alone on its database
gets `:memory:`. When two principals must share a database, for example to test
cross-agent leaks, the case uses a private temporary SQLite file instead,
because an in-memory database is per connection. The file is deleted after the
case.

## Classes (v1)

| Class | Attack | Benign | What an escape would be |
|---|---:|---:|---|
| content | 30 | 10 | An injected instruction payload stored or ingested as `untrusted` reaches default recall, compile or list. Covers 15 payload shapes (override, role prefix, delimiter, zero-width, confusables, encoded, multilingual, tool-call lure, exfiltration image, and others), each via `store` and via document ingest. |
| evidence | 25 | 10 | Untrusted content acquires trust it was not given. Routes tried: metadata claims, evidence fields, reassuring corrections, dependency trust inversion, checkpoints over untrusted data, failed, forged or tampered reflection lessons, re-ingesting a document at a higher trust, forged snapshot imports, self-vouching promotion, and outcome laundering. |
| scope-leak | 30 | 10 | One agent or workspace reads another's private records through any read path, or writes over them by correcting, forgetting, recording outcomes, promoting, checkpointing, deriving lessons or importing. Includes another workspace that uses the same agent id. |
| selection | 26 | 10 | Ranking tricks (term stuffing, rare-term monopoly, flooding, recency, outcome boost, correction boost, key collision, kind filter, limit 1, overlap scoring, and others) get an `untrusted` record selected by default recall or compile. |
| path | 42 | 15 | A promotion is granted on corroboration that is not independent. Variants: dependency, URI and author echoes in three orderings; common ancestors up to depth 4; supersedes chains; pairwise-shared corroborators; superseded or invalidated corroborators; self and duplicate corroboration; laundering through an earlier promotion; checkpoint candidates; and candidates with dependents. |
| erasure-return | 14 | 5 | Forgotten content returns. Routes tried: re-derivation, correction, outcomes, promotion, corroboration, re-ingest of a forgotten source (same, revised or upgraded), restoring from an export taken after the forget, and promotion verdicts that name an erased record. |

Every class has benign controls of the same shape built on legitimately
provenanced data. A kernel that blocks everything therefore fails the gate on
false quarantine.

The content and selection classes test the provenance gate, not content
inspection. Their poison carries an `untrusted` label, and the kernel holds
because default retrieval excludes untrusted records. The kernel does not scan
text for injected instructions. Something written as `observed` is served as
observed.

### Mutation check

To confirm the probes can detect failures, each kernel guard was disabled in turn
in a scratch copy of `dist`, and the suite was rerun against that copy. Every
mutant failed the gate:

| Guard disabled | Effect on the suite |
|---|---|
| Untrusted records excluded from default retrieval | 71 escapes (content 30, evidence 15, selection 26) |
| Agent scope | 22 scope-leak escapes |
| Candidate ancestry check | 13 path escapes, 11 errors |
| Pairwise disjointness check | 3 path escapes |
| Two-corroborator minimum | 1 path escape |
| Dependency trust cap | 3 evidence escapes |
| Erasure of descendants on forget | 4 erasure escapes |
| Runtime tombstone on forgotten sources | 3 erasure escapes |
| Promotion-verdict redaction | 1 erasure escape |

## Promotion rule M3 (`ancestry-disjoint-v1`)

`LocalMemory.promote(id, { to, corroboration, reason })` raises a record from
`untrusted` to `observed`, or from either of those to `verified`. It grants the
promotion only if every one of these conditions holds:

1. The candidate is active, owned by the caller and not a checkpoint, and its
   trust is below `to`.
2. Every dependency of the candidate is at least `to`.
3. At least two distinct corroborators are named (at most 16), and each one is
   visible to the caller, active and at least `to`.
4. **Ancestry-disjoint from the candidate.** A record's ancestry is the set of
   `memory:<id>`, `source:<uri>` and `author:<author>` nodes reachable over
   `dependencies`, `supersedes` and `invalidation.sourceId`, the record itself
   included. No corroborator's ancestry may share any node with the candidate's
   ancestry.
5. **Disjoint from each other.** At least two qualifying corroborators share no
   ancestry node with each other.
6. The candidate has no active dependents (see below).

If the ancestry walk exceeds 10,000 nodes, disjointness cannot be shown, and the
promotion is quarantined.

A granted promotion **supersedes** the candidate. The new record has the higher
trust and carries `metadata.promotion` (`rule`, `at`, `from`, `to`,
`supersededId`, and the corroborating ids). A promotion to `verified` with no
existing evidence gets generated evidence that names the rule and the
corroborators. Trust is part of the bitemporal state, so promotion does not edit
the record in place:

- Replay at any cut point before the promotion still hashes the same state.
- Export and import stay idempotent.

The same constraint is why a candidate with active dependents is quarantined.
Dependencies are immutable, and superseding their source would orphan them.

Every decision, whether granted or quarantined, is written as a `promotion`
ledger event (`ledger({ event: 'promotion' })`). The entry records:

- `memoryId`, `from`, `to`, `decision`, `reason` and `rule`;
- a `verdict` that names each failing condition, including the shared ancestor,
  for example `corroborator <id> shares ancestor source:web://paste/x with the
  candidate`;
- each corroborator's trust, `disjointFromCandidate` flag and `sharedAncestors`;
- `disjointPairs`;
- `promotedId`, when the promotion was granted.

A quarantined promotion changes nothing except the ledger.

Promotion is **outcome-gated and reversible**: `forget` the promoted record to
undo it. Recording a failed outcome against it keeps it out of compiled
context, although `recall` still returns it. It is evidence of independent corroboration, not proof of
truth. Two independent sources can both be wrong.

When a corroborator is forgotten, any promotion entry that names it is redacted
in place. The erased corroborator's id becomes `erased`, the verdict is replaced,
and the decision is kept. Forgetting the candidate or the promoted record erases
the entry together with both versions.

## Known limits, not done in v1

- **Decaying quarantine is not implemented.** A quarantined candidate stays
  `untrusted` until a later promotion succeeds. Nothing ages, expires or
  re-reviews it.
- **Ancestry-disjoint does not mean independent in the world.** Two sources with
  different URIs and authors that copied the same upstream text count as
  disjoint. The rule only sees provenance that was recorded.
- **`import()` trusts snapshot trust labels.** It still enforces scope, id
  conflicts and dependency trust, but a hand-built snapshot with an
  `observed` record and no dependencies is accepted at that label. The suite
  tests forged imports only where a dependency, scope or id conflict is
  involved. Import is an operator path, not an agent path.
- **Opaque-id residue.** A promoted record keeps the ids of its corroborators in
  `metadata.promotion` after a corroborator is forgotten. These are ids only, with
  no text, URI or author.
- **Lexical retrieval only.** Dense and hybrid retrieval are not exercised in v1.
  The trust and scope gates sit in the same kernel SQL, but v1 makes no claim
  about them.
