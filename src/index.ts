/**
 * Mnemosyne — local-first long-term memory for AI agents.
 *
 * The package root exports the local SQLite kernel. Runtime, MCP, HTTP,
 * evaluation and other kernel surfaces have their own subpaths
 * (`mnemosy-ai/runtime`, `mnemosy-ai/mcp`, ...). The 1.x/2.x Qdrant engine
 * (`createMnemosyne`, graph, broadcast and cognitive layers) moved to the
 * separate `mnemosy-ai-legacy` package in 3.0.0; see docs/MIGRATION-v3.md.
 *
 * @example
 * ```typescript
 * import { createLocalMemory } from 'mnemosy-ai'
 *
 * const memory = createLocalMemory({ path: './memory.db', workspaceId: 'demo', agentId: 'my-agent' })
 * ```
 */

export { LocalMemory, createLocalMemory } from "./local/index.js";
export type { MemoryRecord, ContextPacket, MemorySnapshot } from "./local/types.js";
export { reflect, commitVerifiedLesson } from "./reflection/index.js";
export { resolveConfig } from "./config.js";
export type { MnemosyneConfig, MemoryCategory } from "./config.js";
