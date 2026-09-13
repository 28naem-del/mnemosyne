# Bring existing memories into Mnemosyne

The rc5 source candidate imports selected exports from Mem0, Letta, legacy Mnemosyne/Qdrant, and Markdown. Preview first, save the reviewed plan, then apply that exact plan. No account login, model, network request, or source database connection is involved. Build this checkout before using the commands below; publication to npm is a separate step.

Migration creates private records in the local SQLite engine. It leaves the supplied export files unchanged. [Existing v2 compatibility and snapshot notes](MIGRATION-v2.md) describe a different operation: restoring a Mnemosyne local snapshot into the same scope.

## A single export

For a Mem0 JSON array with records such as `{"id":"m1","memory":"Prefers concise updates.","user_id":"alice"}`:

```sh
node dist/cli/index.js migrate \
  --file ./mem0-export.json --profile mem0-array \
  --source-store personal-mem0 --source-owner alice \
  --workspace my-project --agent assistant \
  --acknowledge-partial --out ./reviewed-plan.json
```

Choose a stable `source-store` name for the original account or installation and reuse it for future imports. `source-owner` selects records belonging to that source identity. An array alone cannot establish that the export contains the entire account; `--acknowledge-partial` explicitly accepts that uncertainty. It does not bypass malformed records, conflicting identities, or source-byte limits.

The preview reports counts, completeness, field handling, source hashes and byte accounting. It does not open or create a destination database. The saved plan includes local source paths and review metadata, but omits the actual memory text. It is created as a new private file; an existing output is never overwritten.

Review the report and plan, then apply:

```sh
node dist/cli/index.js migrate --action apply \
  --file ./reviewed-plan.json --db ./agent-memory.sqlite \
  --batch mem0-first-import --confirm
```

The destination workspace and agent come from the plan. Explicit scope flags must match it. Apply rereads the sources and reconstructs the plan; changed bytes or options require another preview. Apply checks existing destination identities and commits the batch atomically. Save its JSON result: it contains the batch ID, source identities and manifest revision needed for inspection or undo.

Imported text defaults to **untrusted** and stays out of ordinary advice. You can inspect it with the source commands below, or opt into untrusted retrieval for review. If you have accepted the exported assertions as reference evidence, set `--trust observed` when creating the plan. This is a controller choice, not proof of correctness. Migration never accepts `verified` trust, turns a persona into system instructions, or activates an imported skill. A later source freshness check does not promote untrusted imports.

## Supported shapes

Use an explicit profile; Mnemosyne does not guess which nested field contains authoritative memory.

- `mem0-array`: a JSON array of Mem0 memory objects. The assertion is `memory`, identity is `id`, and the default selected owner field is `user_id`.
- `mem0-results`: an object with `results` containing that array. A paginated response must use the separate profile below.
- `mem0-page`: `{"count":1,"next":null,"previous":null,"results":[...]}`. Pagination and total-count evidence are reported; provide every page explicitly when claiming a complete set.
- `letta-blocks`: a JSON array of Letta block objects with `id` and `value`. Block labels, read-only flags, limits and metadata remain source data. If the export lacks a creator identity, explicitly assert its scope using `--assume-missing-owner` with the selected `--source-owner`.
- `mnemosyne-memcell-array`: a JSON array of legacy MemCells, including `id`, `text` and `agentId`. Supply `--collection` to distinguish source collections. Legacy confidence, memory kinds and relationships do not become new verified claims or provenance edges.
- `mnemosyne-qdrant-scroll`: a Qdrant scroll response with `result.points` and `result.next_page_offset`. Legacy payload fields include `text`, `agent_id` and `memory_type`. Supply `--collection`; custom payloads additionally require an explicit `--qdrant-text-field`. Vectors are retained only inside the original record, not reused as local embeddings.
- `markdown`: one entire UTF-8 file per artifact, including its BOM, CRLF, frontmatter and code. Supply a stable `--logical-path`, such as `projects/catalogue/MEMORY.md`, and `--assume-missing-owner`. File content remains literal reference data; no commands, hooks or settings are executed.

Custom Mem0 export schemas, Letta AgentFile archives, consumer ChatGPT/Claude/Gemini account archives, graph database dumps, and binary documents are not parsers provided by these profiles. Use a supported selected export or write an explicit mapping. This importer is not a live account synchronization service.

## Multiple files, pages or custom owner selection

Use a manifest when importing multiple files or selecting another supported owner field. Paths resolve relative to the manifest. Save the following as `migration.json`, adapting the identities and source path:

```json
{
  "version": 1,
  "files": [
    {
      "path": "./mem0-page-1.json",
      "profile": "mem0-page",
      "page": { "index": 0, "totalPages": 1 }
    }
  ],
  "options": {
    "sourceStore": "personal-mem0",
    "sourceOwner": { "field": "user", "allowedIds": ["alice"] },
    "destination": { "workspaceId": "my-project", "agentId": "assistant" },
    "trust": "untrusted",
    "acknowledgePartial": false
  }
}
```

```sh
node dist/cli/index.js migrate --file ./migration.json --out ./reviewed-plan.json
```

`page.index` is zero-based; `totalPages` is your declaration about the supplied export. The importer checks it against available page and count evidence; it cannot independently prove a remote account is complete. For missing owner fields, add `sourceOwner.assumeMissing` equal to an allowed source owner. Owner selection can use `agent`, `user` or `creator` where the profile supports it. A partial/excluded-owner result requires explicit acknowledgment before apply.

The CLI fixes `evaluatedAt` at preview time if omitted. The SDK requires that UTC timestamp explicitly, making expiry interpretation and plan digests reproducible. Mem0 expiry is assessed at that frozen instant; a future expiration remains raw evidence and is not installed as a local `validUntil` or scheduled expiration. Preview again after a delay and apply a host freshness policy before relying on time-sensitive imported assertions. Shortcut-specific flags are rejected in manifest mode, preventing a flag from silently overriding reviewed settings.

## Inspect, undo, or forget

All subsequent commands select the same database, workspace and agent:

```sh
node dist/cli/index.js migrate --action inspect \
  --db ./agent-memory.sqlite --workspace my-project --agent assistant \
  --batch mem0-first-import

node dist/cli/index.js migrate --action source \
  --db ./agent-memory.sqlite --workspace my-project --agent assistant \
  --batch mem0-first-import --id SOURCE_ID \
  --json '{"offset":0,"maxBytes":8192}'

node dist/cli/index.js migrate --action rollback \
  --db ./agent-memory.sqlite --workspace my-project --agent assistant \
  --batch mem0-first-import --revision MANIFEST_REVISION --confirm

node dist/cli/index.js migrate --action forget \
  --db ./agent-memory.sqlite --workspace my-project --agent assistant \
  --id SOURCE_ID --confirm
```

Replace `SOURCE_ID` and `MANIFEST_REVISION` with the values returned by inspection. Source paging preserves UTF-8 boundaries and reports how to continue; it is the operation that intentionally returns source text. Batch inspection returns references and state. Opening an existing SQLite database can perform ordinary schema/index initialization; only the pure file preview promises not to open a destination database at all.

**Undo** removes only the unchanged records owned by that import. Later corrections, outcomes, or dependent work make it fail atomically. It never deletes another batch's reused source. A rolled-back batch ID remains terminal; a new batch ID can import again.

**Forget** removes the source's live history and dependent content and leaves a content-free identity tombstone. Renaming or reordering exports does not bypass that tombstone. The stable identity includes source family, store, collection, selected owner and external ID, or Markdown logical path. Deliberately assigning a different store, owner or external identity is outside this replay guarantee. Backups, original export files and text already sent elsewhere are separate copies.

## Fidelity and limits

The importer retains the exact byte span of each selected representative JSON record, including unknown fields. It does not copy the whole wrapper or every duplicate serialization. Markdown is retained as the whole source unit. Reports distinguish retained bytes, excluded/invalid/conflicting bytes, duplicate bytes and framing that was not retained. Equivalent JSON with reordered properties reuses the original stored source; a changed value under the same source identity produces a conflict rather than overwriting it.

Recognized deleted/secret signals, Mem0 expiry/replacement/lifecycle fields, empty content and literal-NUL records are retained only as quarantined source material. They do not become active advice. Other foreign timestamps, lifecycle fields, relationships and Markdown frontmatter remain uninterpreted raw evidence unless the plan reports an explicit mapping; review those before choosing observed trust. Imported vectors, trust labels, outcomes and executable instructions do not grant local authority.

The initial CLI accepts at most **4 MiB across supplied source files, 1,000 records, 256 artifacts, and 65,536 bytes per source unit**. The redacted saved plan must also fit its 4 MiB, depth-32 and 100,000-node readback limits; preview validates these before saving. Split larger exports into explicit batches without splitting a record. The exact JSON parser rejects malformed UTF-8, duplicate keys, unsafe integer-valued numbers and excessive nesting; it retains exact numeric source tokens rather than silently rounding identity comparisons. Apply also enforces inventory, created-record and operation-time budgets. Synchronous SQLite work is not preemptible between its internal steps.

For SDK use, import `planMigration` and `MigrationService` from `mnemosy-ai/migration`. `inspectMigrationPlan` adds destination-aware conflict/reuse checks without applying the batch. Pass the original options to apply, not the normalized `plan.options`. The [executable migration example](../examples/migration.ts) demonstrates the complete lifecycle with an isolated temporary database and no model calls.
