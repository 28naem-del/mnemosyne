export { MemoryPublisher, CHANNELS } from "./publisher.js";
export { MemorySubscriber } from "./subscriber.js";
export type { MessageHandler } from "./subscriber.js";
export {
  analyzeIncomingMemory,
  applyCorroboration,
  synthesizeCollectiveInsight,
} from "./cross-agent.js";
export type { CrossAgentAction } from "./cross-agent.js";
export { SharedBlockManager } from "./shared-blocks.js";
export type { SharedBlock } from "./shared-blocks.js";
export {
  runCollectiveSynthesis,
  buildAgentSummaries,
  findConsensus,
  findContradictions,
  findBlindSpots,
  findComplementary,
  storeInsights,
  formatSynthesisReport,
  getLastReport,
  setLastReport,
} from "./synthesis.js";
export type {
  CollectiveInsight,
  InsightType,
  AgentKnowledgeSummary,
  SynthesisReport,
} from "./synthesis.js";
