/**
 * Voyager-style procedural skill library.
 * Stores executable recipes in a Qdrant collection.
 */

import type { Procedure } from "../core/types.js";

export class SkillLibrary {
  private readonly qdrantUrl: string;
  private readonly collection: string;

  constructor(qdrantUrl: string, collection = "skill_library") {
    this.qdrantUrl = qdrantUrl;
    this.collection = collection;
  }

  async store(
    procedure: Procedure,
    vector: number[],
  ): Promise<void> {
    await fetch(`${this.qdrantUrl}/collections/${this.collection}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wait: true,
        points: [{
          id: procedure.id,
          vector,
          payload: {
            title: procedure.title,
            trigger_phrases: procedure.triggerPhrases,
            prerequisites: procedure.prerequisites,
            steps: procedure.steps,
            outcome: procedure.outcome,
            verified: procedure.verified,
            execution_count: procedure.executionCount,
            created_by: procedure.createdBy,
            created_at: procedure.createdAt,
            updated_at: procedure.updatedAt,
            deleted: false,
          },
        }],
      }),
    });
  }

  async search(
    vector: number[],
    limit = 3,
    minScore = 0.5,
  ): Promise<Array<{ procedure: Procedure; score: number }>> {
    const res = await fetch(`${this.qdrantUrl}/collections/${this.collection}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit,
        filter: { must: [{ key: "deleted", match: { value: false } }] },
        with_payload: true,
      }),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as {
      result: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
    };

    return data.result
      .filter((r) => r.score >= minScore)
      .map((r) => ({
        procedure: {
          id: r.id,
          title: r.payload.title as string,
          triggerPhrases: (r.payload.trigger_phrases as string[]) || [],
          prerequisites: (r.payload.prerequisites as string[]) || [],
          steps: (r.payload.steps as Procedure["steps"]) || [],
          outcome: (r.payload.outcome as string) || "",
          verified: (r.payload.verified as boolean) || false,
          executionCount: (r.payload.execution_count as number) || 0,
          createdBy: (r.payload.created_by as string) || "",
          createdAt: (r.payload.created_at as string) || "",
          updatedAt: (r.payload.updated_at as string) || "",
        },
        score: r.score,
      }));
  }

  async incrementExecution(procedureId: string): Promise<void> {
    // Get current count, increment, update
    const res = await fetch(`${this.qdrantUrl}/collections/${this.collection}/points/${procedureId}`);
    if (!res.ok) return;
    const data = (await res.json()) as { result: { payload: Record<string, unknown> } };
    const count = ((data.result.payload.execution_count as number) || 0) + 1;

    await fetch(`${this.qdrantUrl}/collections/${this.collection}/points/payload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wait: true,
        points: [procedureId],
        payload: { execution_count: count, updated_at: new Date().toISOString() },
      }),
    });
  }
}
