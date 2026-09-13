# Bring existing memories into Mnemosyne

Mnemosyne imports selected exports from Mem0, Letta, LangGraph, Graphiti, Hindsight, Supermemory, legacy Mnemosyne/Qdrant, and Markdown through eleven explicit profiles. Preview first, save the reviewed plan, then apply that exact plan. No account login, model, network request, or source database connection is involved. Build this checkout before using the commands below; publication to npm is a separate step.

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
- `langgraph-store-items`: an array of serialized `Item.dict()` or `SearchItem.dict()` records. Requires `namespace` as an array of strings, `key` as a string, and `value` as a JSON object. The identity includes the entire namespace tuple and key; `['a/b']` and `['a','b']` stay distinct. The entire original JSON `value` becomes literal reference text; the importer does not guess a `text`, `memory` or `profile` property. Search scores, timestamps, TTL, indexing and graph checkpoint semantics are not transferred. [Published Item/SearchItem contract](https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/langgraph/store/base/__init__.py).
- `graphiti-edges`: an array of JSON-serialized `EntityEdge` objects with `uuid`, `group_id` and `fact`. Identity includes the graph group and UUID; an explicitly empty default group is valid. Only `fact` is projected. Endpoints, episodes, embeddings and foreign time axes remain exact raw data without creating local relations or provenance edges. Expired edges, facts not yet valid, elapsed validity and ambiguous timestamps are quarantined. RFC3339 timestamps with explicit offsets or `Z` and up to nine fractional digits are compared without rounding; unknown-offset `-00:00` is not treated as UTC. Future expiry is reported but not scheduled. This is a Graphiti object export, not a Zep account archive parser. [Published EntityEdge contract](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py).
- `hindsight-memories`: the memory list envelope `{"items":[...],"total":1,"limit":100,"offset":0}` with string `id` and `text` in each unit. Requires explicit `state:"valid"` before projecting text; missing, unknown, invalidated or contradictory invalidation state stays quarantined, including in older exports. Proof counts, source fact IDs, entities, event times, tags and observations remain raw data without granting local verification. Use a distinct stable `sourceStore` for each bank. Offset ranges, totals and any caller page declarations are checked. This is not a `recall()` response adapter or a bank configuration transfer. [Hindsight list contract](https://github.com/vectorize-io/hindsight/blob/main/hindsight-clients/python/hindsight_client_api/models/list_memory_units_response.py), [unit contract](https://github.com/vectorize-io/hindsight/blob/main/hindsight-clients/python/hindsight_client_api/models/memory_unit_list_item.py).
- `supermemory-documents`: the v3 list envelope `{"memories":[...],"pagination":{"currentPage":1,"limit":10,"totalItems":1,"totalPages":1}}`. Each document needs string `id` and `content`; export with `includeContent:true`. Missing/null content is rejected rather than replaced with a summary. Only `status:"done"` documents become projected observations. Nested forgotten, outdated or ambiguous memory histories quarantine the entire record. `content` stays literal, including a URL; nothing is fetched. Extracted memories, profiles, container tags, custom IDs, document metadata and connection state remain raw data. The alternate `documents` wrapper and cursor pagination require another adapter. [Published documents list contract](https://supermemory.ai/docs/api-reference/documents/list-documents), [document fields](https://supermemory.ai/docs/api-reference/documents/get-document).

These four additional contracts were checked against primary documentation/source on **2026-09-13**. Their fixtures validate the supported shapes, not live account exports. They contain no authenticated owner field: explicitly supply `sourceOwner.assumeMissing` (CLI `--assume-missing-owner`) and an allowed identity. Graph groups, LangGraph namespaces, Hindsight banks and Supermemory container tags never imply destination ownership or sharing. Separate source stores prevent unrelated banks/accounts from colliding. Changes to the external identity intentionally select another source and are outside replay protection.

Custom Mem0 schemas, Letta AgentFile archives, consumer ChatGPT/Claude/Gemini account archives, Zep hosted archives, Cognee database/dataset dumps, OpenViking context trees, general graph dumps and binary documents are not parsers provided by these profiles. Cognee/OpenViking require explicit content, identity and lifecycle mapping before a native adapter can be promised. Use a supported selected export or write an explicit mapping. This importer is not a live account synchronization service.

For example, preview an already-supplied Hindsight list response from one explicitly selected bank:

```sh
node dist/cli/index.js migrate \
  --file ./hindsight-bank-page.json --profile hindsight-memories \
  --source-store my-hindsight-bank --source-owner alice --assume-missing-owner \
  --workspace my-project --agent assistant \
  --acknowledge-partial --out ./reviewed-hindsight-plan.json
```

An incomplete page selection requires acknowledgment and is reported as partial. Malformed envelopes, impossible pagination, conflicting records, missing required content and contradictory caller page declarations cannot be acknowledged away. No next URL or cursor is followed. Use an explicit manifest for every supplied page when claiming a complete selected set; list responses are not independent proof of a whole account inventory.

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

The CLI fixes `evaluatedAt` at preview time if omitted. The SDK requires that UTC timestamp explicitly, making expiry interpretation and plan digests reproducible. Mem0 expiry and Graphiti validity are assessed at that frozen instant; a future expiration remains raw evidence and is not installed as a local `validUntil` or scheduled expiration. Preview again after a delay and apply a host freshness policy before relying on time-sensitive imported assertions. Shortcut-specific flags are rejected in manifest mode, preventing a flag from silently overriding reviewed settings.

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

Recognized deleted/secret signals, Mem0 expiry/replacement/lifecycle fields, Graphiti invalidation, Hindsight non-valid curation, Supermemory unfinished/historical content, empty content and literal-NUL records are retained only as quarantined source material. They do not become active advice. Other foreign timestamps, lifecycle fields, relationships and Markdown frontmatter remain uninterpreted raw evidence unless the plan reports an explicit mapping; review those before choosing observed trust. Imported vectors, trust labels, outcomes and executable instructions do not grant local authority. Warnings in each new profile name the active semantics not recreated, while field mappings identify which fields remain available only through exact source inspection.

The initial CLI accepts at most **4 MiB across supplied source files, 1,000 records, 256 artifacts, and 65,536 bytes per source unit**. The redacted saved plan must also fit its 4 MiB, depth-32 and 100,000-node readback limits; preview validates these before saving. Split larger exports into explicit batches without splitting a record. The exact JSON parser rejects malformed UTF-8, duplicate keys, unsafe integer-valued numbers and excessive nesting; it retains exact numeric source tokens rather than silently rounding identity comparisons. Apply also enforces inventory, created-record and operation-time budgets. Synchronous SQLite work is not preemptible between its internal steps.

For SDK use, import `planMigration`, `MigrationService` and the frozen `MIGRATION_PROFILES` catalogue from `mnemosy-ai/migration`. `inspectMigrationPlan` adds destination-aware conflict/reuse checks without applying the batch. Pass the original options to apply, not the normalized `plan.options`. The [executable migration example](../examples/migration.ts) demonstrates the complete lifecycle and the four additional competitor formats with an isolated temporary database and no model calls.
