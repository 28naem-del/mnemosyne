/**
 * Memory extraction client.
 * Calls an extraction service API for MemCell extraction.
 * Falls back to local rule-based classification if unavailable.
 *
 * Enhanced: Local entity extraction, domain auto-tagging, better type classification.
 */

import type { MemoryType, Domain } from "../core/types.js";
import { classifyMemoryType, classifyDomain } from "./classifier.js";

export type ExtractionResult = {
  memoryType: MemoryType;
  content: string;
  confidence: number;
  entities: string[];
  domain?: Domain;
  tags?: string[];
};

export class ExtractionClient {
  private readonly baseUrl: string;
  private available = true;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      this.available = res.ok;
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  async extract(text: string, context?: { agentId?: string; userId?: string }): Promise<ExtractionResult | null> {
    if (!this.available) return null;

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          agent_id: context?.agentId,
          user_id: context?.userId,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return null;

      const data = (await res.json()) as {
        memory_type?: string;
        content?: string;
        confidence?: number;
        entities?: string[];
      };

      // Merge API entities with local extraction for completeness
      const apiEntities = data.entities || [];
      const localEntities = extractEntities(text);
      const mergedEntities = [...new Set([...apiEntities, ...localEntities])];

      const domain = classifyDomain(text);
      const tags = autoTag(text, domain);

      return {
        memoryType: (data.memory_type as MemoryType) || "semantic",
        content: data.content || text,
        confidence: data.confidence ?? 0.7,
        entities: mergedEntities,
        domain,
        tags,
      };
    } catch {
      return null;
    }
  }

  /**
   * Enhanced local extraction -- used when extraction service API is unavailable.
   * No LLM calls -- pure regex/keyword extraction.
   */
  extractLocal(text: string): ExtractionResult {
    const memoryType = classifyMemoryType(text);
    const entities = extractEntities(text);
    const domain = classifyDomain(text);
    const tags = autoTag(text, domain);

    // Confidence based on how strongly the text matches patterns
    let confidence = 0.6;
    if (memoryType !== "semantic") confidence = 0.7; // Matched a specific type
    if (entities.length > 0) confidence += 0.05;
    if (tags.length > 1) confidence += 0.05;

    return {
      memoryType,
      content: text,
      confidence: Math.min(confidence, 0.9),
      entities,
      domain,
      tags,
    };
  }
}

// ============================================================================
// Entity Extraction (no LLM -- pure regex)
// ============================================================================

const ENTITY_PATTERNS = {
  // IP addresses (any IPv4)
  ip: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
  // Ports
  port: /\bport\s*[:=]?\s*(\d{2,5})\b/gi,
  // Dates (ISO, natural)
  isoDate: /\b(\d{4}-\d{2}-\d{2})\b/g,
  naturalDate: /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s*\d{4})?\b/gi,
  // Version strings
  version: /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g,
  // Email addresses
  email: /[\w.-]+@[\w.-]+\.\w+/g,
  // URLs
  url: /https?:\/\/[\w.-]+(?::\d+)?(?:\/\S*)?/gi,
  // Proper names (capitalized words not at sentence start, 2+ chars)
  properName: /(?<=[.!?]\s+|^)([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)/g,
};

export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  const lower = text.toLowerCase();

  // IP addresses
  for (const match of text.matchAll(ENTITY_PATTERNS.ip)) {
    entities.add(match[1]);
  }

  // Ports
  for (const match of text.matchAll(ENTITY_PATTERNS.port)) {
    entities.add(`port:${match[1]}`);
  }

  // Dates
  for (const match of text.matchAll(ENTITY_PATTERNS.isoDate)) {
    entities.add(match[1]);
  }
  for (const match of text.matchAll(ENTITY_PATTERNS.naturalDate)) {
    entities.add(match[0]);
  }

  // Versions
  for (const match of text.matchAll(ENTITY_PATTERNS.version)) {
    // Filter out common false positives (e.g. IP octets already captured)
    const v = match[0];
    if (v.includes(".") && !ENTITY_PATTERNS.ip.test(v)) {
      entities.add(v);
    }
    // Reset regex lastIndex since we're reusing the IP pattern
    ENTITY_PATTERNS.ip.lastIndex = 0;
  }

  // Emails
  for (const match of text.matchAll(ENTITY_PATTERNS.email)) {
    entities.add(match[0]);
  }

  // URLs
  for (const match of text.matchAll(ENTITY_PATTERNS.url)) {
    entities.add(match[0]);
  }

  // Tech terms (well-known tools/services)
  const TECH_TERMS = [
    "qdrant", "redis", "mongodb", "falkordb", "docker", "nginx",
    "typescript", "python", "node", "npm", "git", "ssh",
  ];
  for (const term of TECH_TERMS) {
    if (lower.includes(term)) {
      entities.add(term);
    }
  }

  return [...entities];
}

// ============================================================================
// Auto-Tagging (no LLM -- keyword-based domain tagging)
// ============================================================================

const DOMAIN_TAGS: Record<string, { domain: Domain; patterns: RegExp[] }> = {
  infrastructure: {
    domain: "technical",
    patterns: [
      /\b(server|cluster|node|machine|port|docker|container|deploy|ssh|firewall|dns|vpn)\b/i,
      /\b(redis|qdrant|mongodb|falkordb|nginx|haproxy|caddy)\b/i,
      /\b(memory|cpu|disk|ram|gpu|network|bandwidth)\b/i,
    ],
  },
  personal: {
    domain: "personal",
    patterns: [
      /\b(my|mine|personal|private|family|home)\b/i,
      /\b(birthday|anniversary|vacation|health|fitness)\b/i,
    ],
  },
  business: {
    domain: "project",
    patterns: [
      /\b(client|customer|invoice|payment|contract|deal|revenue|budget)\b/i,
      /\b(meeting|call|presentation|proposal|negotiation)\b/i,
    ],
  },
  technical: {
    domain: "technical",
    patterns: [
      /\b(code|function|class|module|api|endpoint|webhook|plugin)\b/i,
      /\b(bug|error|fix|patch|release|version|update|upgrade)\b/i,
      /\b(test|ci|cd|pipeline|build|lint|format)\b/i,
    ],
  },
};

export function autoTag(text: string, baseDomain: Domain): string[] {
  const tags: string[] = [baseDomain];

  for (const [tagName, config] of Object.entries(DOMAIN_TAGS)) {
    if (config.patterns.some(p => p.test(text))) {
      if (!tags.includes(tagName)) {
        tags.push(tagName);
      }
    }
  }

  return tags;
}
