/**
 * Rule-based memory type classifier.
 * Fallback when extraction service is unavailable.
 * Maps text patterns to the 7-type taxonomy.
 */

import type { MemoryType, UrgencyLevel, Domain } from "../core/types.js";

const TYPE_PATTERNS: Array<{ type: MemoryType; patterns: RegExp[] }> = [
  {
    type: "core",
    patterns: [
      /\b(owner|creator|admin|master)\b/i,
      /\btrust\s*=\s*absolute\b/i,
      /\bnever\s+(change|modify|delete)\b/i,
    ],
  },
  {
    type: "procedural",
    patterns: [
      /\bstep\s+\d+/i,
      /\bhow\s+to\b/i,
      /\binstall|setup|configure|deploy\b/i,
      /\brun\s+(the\s+)?command\b/i,
      /```[\s\S]*```/,
    ],
  },
  {
    type: "preference",
    patterns: [
      /\b(prefer|prefers|like|likes|love|loves|hate|hates|dislike|dislikes|want|wants|need|needs|favor|favors)\b/i,
      /\b(always|never)\s+(use|want|do)\b/i,
    ],
  },
  {
    type: "relationship",
    patterns: [
      /\b(coordinates|manages|reports to|works with|collaborates)\b/i,
      /\b(connected to|linked to|depends on)\b/i,
    ],
  },
  {
    type: "profile",
    patterns: [
      /\b(personality|character|style|tone|behavior)\b/i,
      /\bSOUL\b/,
      /\b(is a|acts as|behaves like)\b/i,
    ],
  },
  {
    type: "episodic",
    patterns: [
      /\b(yesterday|today|last\s+(week|month|time)|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
      /\b\d{4}-\d{2}-\d{2}\b/,
      /\b(asked|said|mentioned|told|discussed)\b/i,
    ],
  },
  // Default falls through to "semantic"
];

export function classifyMemoryType(text: string): MemoryType {
  for (const { type, patterns } of TYPE_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return type;
  }
  return "semantic";
}

const URGENCY_PATTERNS: Array<{ level: UrgencyLevel; patterns: RegExp[] }> = [
  {
    level: "critical",
    patterns: [
      /\b(crash|down|broken|fail|emergency|urgent|ASAP|immediately)\b/i,
      /\b(data loss|security|vulnerability|breach)\b/i,
    ],
  },
  {
    level: "important",
    patterns: [
      /\b(should|must|need to|required|deadline|decision)\b/i,
      /\b(blocker|blocking|dependency)\b/i,
    ],
  },
  {
    level: "background",
    patterns: [
      /\b(nice to know|FYI|trivia|fun fact|by the way)\b/i,
    ],
  },
];

export function classifyUrgency(text: string): UrgencyLevel {
  for (const { level, patterns } of URGENCY_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return level;
  }
  return "reference";
}

const DOMAIN_PATTERNS: Array<{ domain: Domain; patterns: RegExp[] }> = [
  {
    domain: "technical",
    patterns: [
      /\b(code|server|port|api|docker|ssh|database|deploy|git|npm|pip)\b/i,
      /\b(error|bug|fix|debug|test|build|compile)\b/i,
    ],
  },
  {
    domain: "personal",
    patterns: [
      /\b(like|prefer|feel|happy|sad|frustrated|excited)\b/i,
      /\b(my|mine|personal|private)\b/i,
    ],
  },
  {
    domain: "project",
    patterns: [
      /\b(project|task|sprint|milestone|deadline|feature|issue)\b/i,
      /\b(roadmap|timeline|schedule|release)\b/i,
    ],
  },
];

export function classifyDomain(text: string): Domain {
  for (const { domain, patterns } of DOMAIN_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return domain;
  }
  return "knowledge";
}

// Compute priority score 0.0-1.0 from urgency and domain
export function computePriorityScore(urgency: UrgencyLevel, domain: Domain): number {
  const urgencyScores: Record<UrgencyLevel, number> = {
    critical: 1.0,
    important: 0.75,
    reference: 0.5,
    background: 0.25,
  };
  const domainBoosts: Record<Domain, number> = {
    technical: 0.1,
    project: 0.05,
    personal: 0.0,
    knowledge: -0.05,
    general: -0.05,
  };
  return Math.min(1.0, Math.max(0.0, urgencyScores[urgency] + domainBoosts[domain]));
}
