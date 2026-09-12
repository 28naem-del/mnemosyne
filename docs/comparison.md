# Choosing a memory system

This is a design comparison based on public primary sources, not a performance ranking. Features in competing systems overlap; this release does not claim that provenance, reflection, temporal graphs, or structured handoffs were invented here.

**Mnemosyne 2 local:** an embedded SQLite kernel with explicit corrections and provenance, scoped handoffs, outcome-aware context, CLI/MCP, and optional bounded reflection. Useful when a controller needs inspectable lifecycle behavior without starting infrastructure. Local retrieval is lexical. Agent-task improvement remains to be measured.

**Graphiti:** temporal knowledge graphs, incremental ingestion, and hybrid retrieval. Consider it when graph relationships and temporal fact handling are central. See [the official repository](https://github.com/getzep/graphiti).

**Mem0:** memory extraction and retrieval infrastructure with integrations and managed options. Consider its ecosystem and deployment choices. See [the official repository](https://github.com/mem0ai/mem0).

**Letta:** stateful agents and programmable memory management integrated with an agent runtime. Consider it when you want memory and agent execution in one system. See [the official repository](https://github.com/letta-ai/letta).

**Cognee:** graph-based knowledge ingestion and retrieval pipelines. Consider it for transforming varied data into retrievable knowledge. See [the official repository](https://github.com/topoteretes/cognee).

**EverMemOS:** episodic memory and consolidation research with an open memory implementation. See [the official repository](https://github.com/EverMind-AI/EverMemOS).

No matched benchmark was run against these systems. Read their current documentation for licensing, configuration, costs, and limits. [The research review](RESEARCH-2026-09-12.md) records the evidence and design decisions behind this release.
