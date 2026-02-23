/**
 * Proactive memory -- anticipate what the user needs before they ask.
 *
 * Three strategies:
 *   1. Topic continuation: If user is working on X, preload context about X
 *   2. Entity expansion: If user mentions a known entity, also load its relationships
 *   3. Temporal patterns: If user often needs Y at this time, preload Y
 *
 * This runs during auto-recall (before_agent_start) to inject richer context
 * than simple query matching provides.
 */

import type { MemCell, MemCellSearchResult, MemoryType } from "../core/types.js";

/**
 * Default technology terms to recognize as entities.
 * Users can extend this via the `techTerms` parameter.
 */
const DEFAULT_TECH_TERMS = [
  "Qdrant", "Redis", "MongoDB", "Docker", "Kubernetes",
  "PostgreSQL", "MySQL", "Nginx", "GraphQL", "gRPC",
  "Kafka", "RabbitMQ", "Elasticsearch", "Prometheus", "Grafana",
];

/**
 * Extract entities from text (named things: projects, tech, proper nouns).
 * Configurable -- users can pass additional terms to recognize.
 */
export function extractEntities(
  text: string,
  additionalTerms: string[] = [],
): string[] {
  const entities: string[] = [];

  // Technology and tool names
  const allTerms = [...DEFAULT_TECH_TERMS, ...additionalTerms];
  const techPattern = new RegExp(
    `\\b(${allTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "gi",
  );
  const tech = text.match(techPattern);
  if (tech) entities.push(...tech.map(t => t.toLowerCase()));

  // Capitalized proper nouns (2+ chars, not at sentence start heuristic)
  const properNouns = text.match(/(?<=\s)[A-Z][a-zA-Z]{2,}(?=[^a-z]|\b)/g);
  if (properNouns) {
    // Filter out common English words that happen to be capitalized
    const commonWords = new Set([
      "The", "This", "That", "These", "Those", "When", "Where", "What",
      "Which", "How", "Why", "Who", "Also", "Just", "Only", "Some",
      "Any", "All", "Each", "Every", "Not", "But", "And", "For",
      "With", "From", "Into", "About", "After", "Before", "Between",
      "Here", "There", "Then", "Now", "Very", "Most", "More",
    ]);
    for (const noun of properNouns) {
      if (!commonWords.has(noun)) {
        entities.push(noun.toLowerCase());
      }
    }
  }

  // Port references
  const ports = text.match(/\bport\s+(\d{4,5})\b/gi);
  if (ports) entities.push(...ports);

  return [...new Set(entities)];
}

/**
 * Determine what ADDITIONAL memories would be useful beyond the direct query match.
 */
export function computeProactiveQueries(
  userPrompt: string,
  directResults: MemCellSearchResult[],
  additionalTerms: string[] = [],
): string[] {
  const queries: string[] = [];
  const entities = extractEntities(userPrompt, additionalTerms);

  // Strategy 1: Entity expansion -- if they mention a known entity, also get its relationships
  for (const entity of entities) {
    if (userPrompt.toLowerCase().includes(entity)) {
      queries.push(`${entity} configuration setup`);
      queries.push(`${entity} connected services`);
    }
  }

  // Strategy 2: Topic continuation -- look at what types of memories were found
  // and fill gaps. If all results are semantic, try to find procedural context too.
  const foundTypes = new Set(directResults.map(r => r.entry.memoryType));
  const infraEntities = entities.filter(e =>
    ["qdrant", "redis", "mongodb", "docker", "kubernetes",
     "postgresql", "mysql", "nginx", "kafka", "elasticsearch"].includes(e),
  );

  if (!foundTypes.has("procedural") && infraEntities.length > 0) {
    // User mentioned tech but no procedures found -- they might need how-to
    queries.push(`how to ${infraEntities[0]} setup`);
  }

  // Limit to 2 proactive queries to avoid overloading context
  return queries.slice(0, 2);
}

/**
 * Merge direct + proactive results, dedup, and rank.
 */
export function mergeProactiveResults(
  directResults: MemCellSearchResult[],
  proactiveResults: MemCellSearchResult[],
  maxTotal: number,
): MemCellSearchResult[] {
  const seenIds = new Set(directResults.map(r => r.entry.id));
  const merged = [...directResults];

  for (const r of proactiveResults) {
    if (seenIds.has(r.entry.id)) continue;
    if (merged.length >= maxTotal) break;

    // Proactive results get a small score penalty (they're supplementary)
    merged.push({ ...r, score: r.score * 0.85 });
    seenIds.add(r.entry.id);
  }

  return merged.sort((a, b) => b.score - a.score).slice(0, maxTotal);
}

/**
 * Format proactive memories with clear labeling so the LLM knows they're supplementary.
 */
export function formatProactiveContext(
  directMemories: Array<{ text: string; memoryType: MemoryType; confidenceTag?: string }>,
  proactiveMemories: Array<{ text: string; memoryType: MemoryType; confidenceTag?: string }>,
): string {
  const lines: string[] = [];

  if (directMemories.length > 0) {
    for (const [i, m] of directMemories.entries()) {
      const tag = m.confidenceTag ? ` [${m.confidenceTag}]` : "";
      lines.push(`${i + 1}. [${m.memoryType}]${tag} ${m.text}`);
    }
  }

  if (proactiveMemories.length > 0) {
    lines.push("--- Related context (proactively loaded) ---");
    for (const m of proactiveMemories) {
      const tag = m.confidenceTag ? ` [${m.confidenceTag}]` : "";
      lines.push(`+ [${m.memoryType}]${tag} ${m.text}`);
    }
  }

  return lines.join("\n");
}
