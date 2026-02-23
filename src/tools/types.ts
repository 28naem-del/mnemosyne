/**
 * Shared option types for memory tools.
 */

import type { MemoryType, UrgencyLevel, Domain, Classification } from "../core/types.js";

export interface StoreOptions {
  importance?: number;
  memoryType?: MemoryType;
  urgency?: UrgencyLevel;
  domain?: Domain;
  classification?: Classification;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface RecallOptions {
  limit?: number;
  minScore?: number;
  userId?: string;
  includeChains?: boolean;
  filters?: Record<string, unknown>;
}

export interface ForgetOptions {
  query?: string;
  memoryId?: string;
  collection?: string;
}
