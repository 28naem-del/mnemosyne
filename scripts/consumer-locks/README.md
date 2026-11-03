# Reviewed consumer lock templates

Core and optional package.json/package-lock.json/provenance.json files are unchanged npm outputs from the genuine PR107 bootstrap run41628045676, artifact13227436459. The tested checkout77f06c377b62f6cb13cc5d54cf973623b4ca7ca3 has tree3fd86258eb2ae0fd75428f1b49975d4b9f21f8e4. Node24.22.1/npm11.19.1 generated both profiles from the same tarball. Their historical provenance kind describes the bootstrap acquisition, not active generation in CI. The original tarball is not committed.

The core lock has33 records and optional103. Preserve all registry entries, including OS/CPU/libc-specific optional packages; do not prune locks for the runner's platform. Optional transformers3.8.1 retains its reviewed sharp0.35.5 override. Optional ioredis peer remains optional as before. Versions/integrities are npm-generated, not inferred from root dependency ranges.

prepare-consumer.mjs verifies template byte hashes, registry fingerprints, dependency/optional/required-peer edge existence, current source and actual packed-manifest contracts, plus current npm pack hashes. It copies the exact tarball bytes into a fresh consumer as artifact.tgz and changes only three local references and that local receipt's integrity. This makes prepared files path-independent. It never resolves ranges or modifies registry records. Optional peers may be absent; closure checking is not a new semver resolver. Reviewed npm provenance and real npm ci provide version-compatibility evidence.

After npm ci, --check rejects manifest/lock/registry/tarball-copy drift and requires the optional transformer runtime when selected. This metadata check is NOT an installed-artifact/native/demos check or an audit: workflows must also run the unchanged verify-package.mjs and real high-severity optional npm audit. Lifecycle scripts remain ignored; native/model test provisioning elsewhere remains intact.

## Maintenance — explicit, separately reviewed only

A package identity/version/dependency/peer/optional/bin/engine/platform/license contract change must fail closed until templates are refreshed. In an approved environment, build/pack the exact intended source once; obtain genuine fresh core and optional consumer manifest/locks with the same optional override and full platform closure. Record source/run/tool/pack identity and hashes, run real npm ci, audit and artifact verification. Review all registry/version/integrity changes and update template descriptors/tests in the same reviewed change. Preserve source and installed artifact binding.

Do not generate locks during smoke tests, silently update versions on mismatch, invent integrity, suppress audit, omit optional dependencies, or reinstate automatic bootstrap export. No automatic update workflow or new resolver/service is authorized by this note. The full original download/provenance evidence is retained by the coordinator; templates.json binds the acquisition manifest and exact copied file hashes.
