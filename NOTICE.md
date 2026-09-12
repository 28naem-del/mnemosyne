# Research lineage and dependencies

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

The September 8 workspace notes attribute parts of the original project's inspiration to Graphiti, Cognee, EverMemOS, Mastra and Mem0. That historical record does not establish which upstream code was copied or prove production parity. The original license and authorship remain intact.

Runtime third-party dependencies: the official MCP TypeScript server SDK (MIT), Zod (MIT), and uuid (MIT, legacy backend). SQLite is supplied by Node.js; the local entry point uses Node built-ins. Each dependency retains its own license. Research discussion of OpenViking does not import its AGPL server code into this distribution.

See [the research review](docs/RESEARCH-2026-09-12.md) for primary sources, corrections to older notes, and how the findings affected implementation.
