/**
 * ACT-R memory decay model.
 *
 * Activation(i) = ln(Sum t_j^(-d)) + beta
 *
 * Where:
 *   t_j = hours since j-th access
 *   d = decay rate (varies by urgency)
 *   beta = base constant (varies by urgency)
 *
 * Memories below -2.0 activation are "forgotten" (unfindable).
 * Memories below -4.0 are archived (moved to cold storage).
 */

import { DECAY_RATES, type UrgencyLevel, type MemoryType } from "../core/types.js";

export function computeActivation(
  accessTimes: number[],
  urgency: UrgencyLevel,
  memoryType: MemoryType,
  nowMs = Date.now(),
  createdAtMs?: number,
): number {
  // Core and procedural memories never decay
  if (memoryType === "core") return 10.0;
  if (memoryType === "procedural") return 5.0;

  const { d, beta } = DECAY_RATES[urgency] || DECAY_RATES.reference;

  if (!accessTimes || accessTimes.length === 0) {
    // Use created_at as synthetic access time if available
    // Otherwise return 0.0 (active) — never archive just because metadata is missing
    if (createdAtMs && createdAtMs > 0) {
      const hoursSince = Math.max((nowMs - createdAtMs) / 3_600_000, 0.001);
      const sum = Math.pow(hoursSince, -d);
      const activation = (sum > 0 ? Math.log(sum) : 0) + beta;
      // Clamp: never archive a memory just because it's old and missing access_times
      return Math.max(0.0, activation);
    }
    return 0.0;
  }

  // Build effective access times list
  const effectiveTimes = accessTimes;

  let sum = 0;
  for (const accessTime of effectiveTimes) {
    const hoursSince = Math.max((nowMs - accessTime) / 3_600_000, 0.001);
    sum += Math.pow(hoursSince, -d);
  }

  return (sum > 0 ? Math.log(sum) : -999) + beta;
}

export type DecayStatus = "active" | "forgotten" | "archive";

export function getDecayStatus(activation: number): DecayStatus {
  if (activation >= -2.0) return "active";
  if (activation >= -4.0) return "forgotten";
  return "archive";
}

// Apply decay-based reranking boost/penalty to search score
export function applyDecayBoost(searchScore: number, activation: number): number {
  // Normalize activation to 0-1 range: -4 maps to 0, +3 maps to 1
  const normalized = Math.min(1.0, Math.max(0.0, (activation + 4) / 7));
  // Blend: 80% original score, 20% decay factor
  return searchScore * 0.8 + normalized * 0.2;
}
