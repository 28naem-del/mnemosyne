/**
 * Cognitive layer -- all memory intelligence modules.
 *
 * Re-exports every public function, type, and class from the cognitive subsystem.
 */

// -- Decay (ACT-R activation) --
export {
  computeActivation,
  getDecayStatus,
  applyDecayBoost,
  type DecayStatus,
} from "./decay.js";

// -- Confidence scoring --
export {
  computeConfidence,
  confidenceLabel,
} from "./confidence.js";

// -- Multi-signal retrieval --
export {
  detectQueryIntent,
  computeMultiSignalScore,
  applyDiversityReranking,
  type QueryIntent,
  type QueryContext,
  type TrustResolver,
  type ExtendedIntent,
} from "./retrieval.js";

// -- Intent classification & routing --
export {
  classifyExtendedIntent,
  getStrategy,
  rewriteForEmbedding,
  routeQuery,
  INTENT_MIN_THRESHOLDS,
  type SearchStrategy,
  type RoutingResult,
} from "./intent.js";

// -- Sentiment & frustration tracking --
export {
  analyzeSentiment,
  newFrustrationState,
  updateFrustration,
  computeAdaptation,
  formatFrustrationContext,
  type Sentiment,
  type SentimentSignal,
  type FrustrationState,
  type SentimentAdaptation,
} from "./sentiment.js";

// -- Preference tracking --
export {
  extractPreferenceSignals,
  loadUserModel,
  updateModel,
  saveUserModel,
  preferenceBoost,
  formatUserModel,
  resetUserModel,
  getCachedModel,
  type PreferenceCategory,
  type Preference,
  type UserModel,
  type PreferenceSignal,
} from "./preferences.js";

// -- Memory consolidation --
export {
  analyzeForConsolidation,
  findMergeCandidates,
  applyConsolidationAction,
  findContradictions,
  mergeNearDuplicates,
  promotePopular,
  demoteStale,
  runConsolidation,
  type ConsolidationAction,
  type ConsolidationReport,
} from "./consolidation.js";

// -- Dream consolidation (overnight batch) --
export {
  dreamDedup,
  dreamMerge,
  dreamPrune,
  dreamStrengthen,
  shouldRunDream,
  getLastDreamReport,
  runDreamConsolidation,
  formatDreamReport,
  type DreamPhase,
  type DreamReport,
  type DreamConfig,
} from "./dream.js";

// -- Self-improving retrieval feedback --
export {
  detectFeedbackSignal,
  computeFeedback,
  buildFeedbackPayload,
  applyFeedback,
  detectReferencedMemories,
  computeReferenceFeedback,
  memoryFeedback,
  type FeedbackSignal,
  type FeedbackResult,
} from "./feedback.js";

// -- Lesson extraction --
export {
  detectLessons,
  detectStandaloneLessons,
  storeLessons,
  findRelevantLessons,
  listLessons,
  type LessonType,
  type Lesson,
  type LessonExtractionResult,
} from "./lesson-extractor.js";

// -- Pattern mining --
export {
  computeTfIdf,
  extractCorpusTopics,
  buildSimilarityMatrix,
  clusterMemories,
  mineCoOccurrences,
  detectRecurringErrors,
  synthesizePatterns,
  savePatterns,
  loadPatterns,
  runPatternMining,
  type GraphClient,
  type Pattern,
  type PatternType,
  type MemoryCluster,
  type CoOccurrence,
  type MiningReport,
} from "./pattern-miner.js";

// -- Pattern abstraction --
export {
  findCommonSignificantWords,
  abstractCluster,
  abstractRecurringError,
  abstractCoOccurrence,
  runAbstraction,
  storeAbstractedLessons,
  type AbstractedLesson,
  type AbstractionConfig,
} from "./pattern-abstractor.js";

// -- Proactive warnings --
export {
  findWarningLessons,
  findPatternPredictions,
  findPreferenceReminders,
  formatWarningContext,
  gatherProactiveWarnings,
  type SuggestionType,
  type SuggestionPriority,
  type ProactiveSuggestion,
  type ProactiveWarningContext,
} from "./warnings.js";

// -- Voyager-style skill library --
export { SkillLibrary } from "./skills.js";

// -- Reasoning chains (Flow of Thought) --
export {
  followChain,
  enrichWithChains,
  formatChainContext,
  type ChainLink,
  type ReasoningChain,
} from "./chains.js";

// -- Theory of Mind for Agents --
export {
  resolveAgentId,
  detectAgentMention,
  whatAgentKnows,
  knowledgeGap,
  agentProfile,
  formatAgentKnowledge,
  formatKnowledgeGap,
  formatAgentProfile,
  type AgentRegistry,
  type AgentKnowledge,
  type KnowledgeGapResult,
  type AgentProfileSummary,
} from "./toma.js";

// -- Proactive memory anticipation --
export {
  extractEntities,
  computeProactiveQueries,
  mergeProactiveResults,
  formatProactiveContext,
} from "./proactive.js";
