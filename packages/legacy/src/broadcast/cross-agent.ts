/**
 * Cross-agent reasoning -- agents build on each other's insights.
 *
 * When an agent stores a memory, other agents can:
 *   1. Corroborate: "I saw the same thing" -> confidence boost
 *   2. Extend: "Building on that, here's more context"
 *   3. Challenge: "I have contradicting evidence"
 *   4. Synthesize: Combine multiple agent perspectives into a collective insight
 *
 * This creates collective intelligence -- the group is smarter than any single agent.
 */

import type { MemCell, BroadcastMessage, ConfidenceTag } from "../core/types.js";

export type CrossAgentAction =
  | { type: "corroborate"; memoryId: string; byAgent: string; newConfidence: number; newTag: ConfidenceTag }
  | { type: "extend"; originalId: string; extensionText: string; byAgent: string }
  | { type: "challenge"; memoryId: string; byAgent: string; reason: string; evidence: string }
  | { type: "synthesize"; sourceIds: string[]; synthesisText: string; byAgents: string[] };

// When we receive a broadcast from another agent, decide how to react
export function analyzeIncomingMemory(
  incoming: BroadcastMessage,
  localMemories: MemCell[],
  ownAgentId: string,
): CrossAgentAction | null {
  if (incoming.agentId === ownAgentId) return null; // Don't react to own memories

  // Find local memories similar to the incoming one
  const related = localMemories.filter(m => {
    // Check text similarity (basic word overlap)
    const incomingWords = new Set(incoming.textPreview.toLowerCase().split(/\s+/));
    const localWords = new Set(m.text.toLowerCase().split(/\s+/).slice(0, 20));
    let overlap = 0;
    for (const w of incomingWords) {
      if (localWords.has(w) && w.length > 3) overlap++;
    }
    return overlap >= 3; // At least 3 significant words in common
  });

  if (related.length === 0) return null;

  // Corroborate: we have similar info -> boost confidence
  const corroborating = related.filter(m =>
    !m.text.match(/\b(not|no|never|don't|doesn't|isn't|wasn't)\b/i) &&
    !incoming.textPreview.match(/\b(not|no|never|don't|doesn't|isn't|wasn't)\b/i)
  );

  if (corroborating.length > 0) {
    // Multiple agents agreeing = higher confidence
    const currentConfidence = corroborating[0].confidence ?? 0.7;
    const newConfidence = Math.min(1.0, currentConfidence + 0.1);
    const newTag: ConfidenceTag = newConfidence >= 0.85 ? "verified" : "grounded";

    return {
      type: "corroborate",
      memoryId: incoming.memoryId,
      byAgent: ownAgentId,
      newConfidence,
      newTag,
    };
  }

  return null;
}

// Apply a corroboration to boost a memory's confidence in Qdrant
export async function applyCorroboration(
  qdrantUrl: string,
  collection: string,
  action: CrossAgentAction & { type: "corroborate" },
): Promise<boolean> {
  try {
    // Get current memory state
    const res = await fetch(`${qdrantUrl}/collections/${collection}/points/${action.memoryId}`);
    if (!res.ok) return false;
    const data = (await res.json()) as { result: { payload: Record<string, unknown> } };

    const currentMeta = (data.result.payload.metadata as Record<string, unknown>) || {};
    const corroborators = (currentMeta.corroborated_by as string[]) || [];
    if (!corroborators.includes(action.byAgent)) {
      corroborators.push(action.byAgent);
    }

    await fetch(`${qdrantUrl}/collections/${collection}/points/payload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wait: true,
        points: [action.memoryId],
        payload: {
          confidence: action.newConfidence,
          confidence_tag: action.newTag,
          metadata: {
            ...currentMeta,
            corroborated_by: corroborators,
            corroboration_count: corroborators.length,
            last_corroborated: new Date().toISOString(),
          },
        },
      }),
    });
    return true;
  } catch {
    return false;
  }
}

// Generate collective insight from multiple agent perspectives
export function synthesizeCollectiveInsight(
  memories: MemCell[],
  topic: string,
): { synthesis: string; contributors: string[]; confidence: number } | null {
  if (memories.length < 2) return null;

  // Group by agent
  const byAgent = new Map<string, MemCell[]>();
  for (const m of memories) {
    const agentMems = byAgent.get(m.agentId) || [];
    agentMems.push(m);
    byAgent.set(m.agentId, agentMems);
  }

  if (byAgent.size < 2) return null; // Need perspectives from 2+ agents

  const contributors = [...byAgent.keys()];

  // Simple synthesis: take the highest-confidence memory from each agent
  const perspectives: string[] = [];
  for (const [agentId, mems] of byAgent) {
    const best = mems.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    perspectives.push(`[${agentId}] ${best.text.slice(0, 150)}`);
  }

  // Confidence: average of all contributors, boosted by count
  const avgConf = memories.reduce((sum, m) => sum + (m.confidence ?? 0.7), 0) / memories.length;
  const countBoost = Math.min(0.15, (contributors.length - 1) * 0.05); // +0.05 per additional agent, max +0.15

  return {
    synthesis: `[Collective synthesis on "${topic}"] ${perspectives.join(" | ")}`,
    contributors,
    confidence: Math.min(1.0, avgConf + countBoost),
  };
}
