/**
 * preferences — User preference tracking and modeling.
 *
 * Extracts preference signals from text, maintains a running
 * user model, and provides preference-based search boosting.
 */

import {
  extractPreferenceSignals,
  loadUserModel,
  updateModel,
  saveUserModel,
  preferenceBoost,
  formatUserModel,
  resetUserModel,
  type UserModel,
  type PreferenceSignal,
} from "../cognitive/preferences.js";

export interface PreferenceContext {
  qdrantUrl: string;
  redisUrl: string;
  agentId: string;
}

export async function preferences(
  ctx: PreferenceContext,
  userId: string,
): Promise<UserModel> {
  return loadUserModel(ctx.qdrantUrl, ctx.redisUrl, userId, ctx.agentId);
}

export function extractPreferences(text: string): PreferenceSignal[] {
  return extractPreferenceSignals(text);
}

export async function updatePreferences(
  ctx: PreferenceContext,
  userId: string,
  signals: PreferenceSignal[],
  embedVector: number[],
): Promise<UserModel> {
  const model = await loadUserModel(ctx.qdrantUrl, ctx.redisUrl, userId, ctx.agentId);
  const updated = updateModel(model, signals);
  await saveUserModel(ctx.qdrantUrl, ctx.redisUrl, updated, embedVector);
  return updated;
}

export async function resetPreferences(
  ctx: PreferenceContext,
  userId: string,
): Promise<void> {
  return resetUserModel(ctx.qdrantUrl, ctx.redisUrl, userId, ctx.agentId);
}

export { preferenceBoost, formatUserModel };
