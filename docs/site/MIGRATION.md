# Mnemosyne Full Migration

Bring existing memories into Mnemosyne through an explicit export workflow. The migration service supports eleven source profiles, previews the selected records, preserves their original source bytes and reports unsupported or conflicting input. It accepts supplied files and owner selection; it does not discover accounts or connect to another service automatically.

## A single export

Preview before applying. A preview does not open the destination database, and a successful apply commits the selected migration atomically. Stable origin identities detect replays and conflicting revisions. Imported material retains its trust and provenance boundaries rather than becoming verified advice merely because it was transferred.

## Supported shapes

Profiles cover common memory records, virtual text blocks, structured store items, temporal relationship exports, documents and legacy Mnemosyne data. Exact source fields and ownership rules differ by profile. Use the profile matching your actual export; a collection name, group or tag alone is not proof of ownership. Unsupported embedding spaces, graph behavior and foreign policy semantics are not recreated automatically.

## Inspect, undo, or forget

Inspect a migration's selected origins and results before depending on them. Undo is guarded against subsequent dependent work; it is not an unconditional rewind. Privacy forgetting removes matching local origin content and dependent records, and shared origin tombstones can block reimport through both full and gradual migration. Deleting the external account's copy remains a separate action.

## Fidelity and limits

This is a bounded offline importer, not universal account synchronization. Preserve the original export and review counts, errors and unsupported fields. For lower-disruption adoption, [Gradual Migration](/docs/reference/BRIDGE.html) copies returned search results while the old backend remains connected. For complete local database recovery, use [Recovery](/docs/reference/OPERATIONS.html).
