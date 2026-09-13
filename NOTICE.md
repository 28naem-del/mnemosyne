# Attribution and dependencies

Mnemosyne is distributed under the existing MIT license. This upgrade implements its new local kernel and reflection controls independently; it does not copy upstream memory-system source code.

The design draws on established work rather than claiming exclusive invention:

- [Graphiti](https://github.com/getzep/graphiti): temporal provenance and explicit supersession.
- [Cognee](https://docs.cognee.ai/core-concepts/main-operations/improve): experience refinement and evidence-linked lessons.
- [EverOS / EverMemOS](https://github.com/EverMind-AI/EverOS): portable user/agent memory and episode organization.
- [Mastra observational memory](https://mastra.ai/docs/memory/observational-memory): compact context and source-backed observations.
- [Mem0](https://github.com/mem0ai/mem0): memory reconciliation and retrieval.
- [Letta](https://github.com/letta-ai/letta-code): inspectable persistent context and reusable skills.
- [ReasoningBank](https://github.com/google-research/reasoning-bank): external experience distilled from successful and failed trajectories.
- [Voyager](https://voyager.minedojo.org/): reusable skill libraries validated in an environment.

These references describe research influences, not performance rankings or proof of production parity. The original license and authorship remain intact.

Runtime third-party dependencies: the official MCP TypeScript server SDK (MIT), Zod (MIT), and uuid (MIT, legacy backend). SQLite is supplied by Node.js; the local entry point uses Node built-ins. Each dependency retains its own license. Research discussion of OpenViking does not import its AGPL server code into this distribution.

Optional CPU inference uses separately installed third-party software and separately provisioned models. Their identities, pinned revisions, Apache-2.0 licenses and source model cards are listed in [local-model attribution](docs/LOCAL-MODELS.md#reproducibility-and-attribution). Mnemosyne supplies the integration and memory lifecycle; it does not claim authorship of those inference libraries or model weights.

Evaluation reports retain dataset attribution, revisions and result metadata. The public benchmark conversation corpora are not bundled; users acquire them separately under their upstream terms. See the [corpus protocol](docs/evaluation/CORPUS_PROTOCOL.md) for dataset sources and license distinctions. Included synthetic fixtures and recorded demonstrations are first-party examples, not user memory exports.

See [the research review](docs/RESEARCH-2026-09-12.md) for primary sources and the design decisions they informed.

The static website vendors the official Three.js 0.185.1 browser modules under the MIT license. Its license, official archive URL and verified checksums are retained in [site/vendor/three](site/vendor/three/SOURCE.md). This renderer is used only for the illustrative interactive sculpture, independently of the memory engine.
