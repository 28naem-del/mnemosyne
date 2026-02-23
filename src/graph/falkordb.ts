/**
 * FalkorDB temporal knowledge graph client.
 * FalkorDB speaks Redis protocol on a configurable port.
 * Uses GRAPH.QUERY for Cypher operations.
 *
 * Schema:
 *   (Entity {name, type, first_seen, last_seen})
 *   -[RELATES_TO {type, since, confidence}]->
 *   (Entity {name, type, first_seen, last_seen})
 */

export class FalkorDBClient {
  private redis: import("ioredis").default | null = null;
  private readonly redisUrl: string;
  private readonly graphName: string;

  /** Optional regex for known host/node names to extract as entities. */
  private readonly knownHostPattern: RegExp | null;

  constructor(
    redisUrl: string,
    graphName = "knowledge_graph",
    opts?: { knownHostPattern?: RegExp },
  ) {
    this.redisUrl = redisUrl;
    this.graphName = graphName;
    this.knownHostPattern = opts?.knownHostPattern ?? null;
  }

  async connect(): Promise<void> {
    if (this.redis) return;
    const Redis = (await import("ioredis")).default;
    this.redis = new Redis(this.redisUrl, {
      lazyConnect: true,
      connectTimeout: 5000,
    });
    await this.redis.connect();

    // Create indexes on first connect
    await this.query(
      "CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.name)"
    ).catch(() => {}); // Ignore if already exists
  }

  async query(cypher: string, params?: Record<string, unknown>): Promise<unknown[]> {
    if (!this.redis) return [];
    try {
      // FalkorDB uses GRAPH.QUERY command
      const args = [this.graphName, cypher];
      if (params) {
        // FalkorDB accepts params via CYPHER prefix
        const paramStr = Object.entries(params)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ");
        args[1] = `CYPHER ${paramStr} ${cypher}`;
      }
      const result = await this.redis.call("GRAPH.QUERY", ...args) as unknown[];
      return result || [];
    } catch {
      return [];
    }
  }

  // Add an entity node
  async addEntity(
    name: string,
    type: string,
    properties: Record<string, unknown> = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    const allProps = { ...properties, first_seen: now, last_seen: now };

    // Build parameterized SET clauses for additional properties
    const params: Record<string, unknown> = { name, type, now };
    const setEntries: string[] = [`e.type = $type`];
    let idx = 0;
    for (const [k, v] of Object.entries(allProps)) {
      const paramKey = `p${idx++}`;
      params[paramKey] = v;
      setEntries.push(`e.${k} = $${paramKey}`);
    }

    await this.query(
      `MERGE (e:Entity {name: $name})
       ON CREATE SET ${setEntries.join(", ")}
       ON MATCH SET e.last_seen = $now`,
      params,
    );
  }

  // Add a relationship between entities
  async addRelationship(
    fromName: string,
    toName: string,
    relType: string,
    properties: Record<string, unknown> = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    const confidence = properties.confidence ?? 0.8;
    // Relationship types must be identifiers in Cypher, not parameterizable.
    // Validate to prevent injection via relType.
    const safeRelType = relType.toUpperCase().replace(/[^A-Z0-9_]/g, "");

    await this.query(
      `MATCH (a:Entity {name: $fromName})
       MATCH (b:Entity {name: $toName})
       MERGE (a)-[r:${safeRelType}]->(b)
       ON CREATE SET r.since = $now, r.confidence = $confidence
       ON MATCH SET r.last_seen = $now`,
      { fromName, toName, now, confidence },
    );
  }

  // Find entities related to a query
  async findRelated(entityName: string, depth = 1): Promise<unknown[]> {
    // Depth must be a safe integer for Cypher range
    const safeDepth = Math.max(1, Math.min(Math.floor(depth), 5));
    return this.query(
      `MATCH (e:Entity {name: $entityName})-[r*1..${safeDepth}]-(related)
       RETURN related.name, related.type, type(r) AS rel_type
       LIMIT 20`,
      { entityName },
    );
  }

  // Extract entities from memory text and add to graph
  async ingestMemory(
    memoryId: string,
    text: string,
    entities: string[],
    agentId: string,
    eventTime?: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    // Add memory as a node with bi-temporal timestamps
    await this.addEntity(memoryId, "Memory", {
      text: text.slice(0, 200),
      agent_id: agentId,
      event_time: eventTime || now,   // When it happened
      ingested_at: now,               // When we learned it
    });

    // Auto-extract entities via regex if none provided
    const allEntities = entities.length > 0 ? entities : this.extractEntities(text);

    // Add extracted entities and link to memory
    for (const entity of allEntities) {
      const entityType = this.classifyEntity(entity);
      await this.addEntity(entity, entityType);
      await this.addRelationship(memoryId, entity, "MENTIONS");
    }

    // Link to agent
    await this.addEntity(agentId, "Agent");
    await this.addRelationship(memoryId, agentId, "CREATED_BY");
  }

  /**
   * Temporal query: "What did we know about X as of date Y?"
   * Returns entities and relationships that existed before the given date.
   */
  async temporalQuery(entityName: string, asOfDate?: string): Promise<unknown[]> {
    if (!asOfDate) {
      return this.findRelated(entityName, 2);
    }

    return this.query(
      `MATCH (e:Entity {name: $entityName})-[r]-(related)
       WHERE r.since <= $asOfDate
       RETURN related.name, related.type, type(r) AS rel_type, r.since AS since, r.confidence AS confidence
       ORDER BY r.since DESC
       LIMIT 20`,
      { entityName, asOfDate },
    );
  }

  /**
   * Find the causal chain: how entity A connects to entity B through the graph.
   */
  async findPath(fromEntity: string, toEntity: string, maxDepth = 3): Promise<unknown[]> {
    const safeDepth = Math.max(1, Math.min(Math.floor(maxDepth), 10));
    return this.query(
      `MATCH path = shortestPath(
         (a:Entity {name: $fromEntity})-[*1..${safeDepth}]-(b:Entity {name: $toEntity})
       )
       RETURN nodes(path), relationships(path)
       LIMIT 5`,
      { fromEntity, toEntity },
    );
  }

  /**
   * Get timeline of events for an entity.
   */
  async getTimeline(entityName: string, limit = 20): Promise<unknown[]> {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    return this.query(
      `MATCH (e:Entity {name: $entityName})-[r]-(related:Entity {type: 'Memory'})
       RETURN related.text AS event, related.event_time AS event_time, related.ingested_at AS learned_at, type(r) AS relationship
       ORDER BY related.event_time DESC
       LIMIT ${safeLimit}`,
      { entityName },
    );
  }

  /**
   * Regex-based entity extraction from text (no LLM calls).
   * Extracts: IP addresses, technology names, dates, port references,
   * and optionally known host names (if configured via knownHostPattern).
   */
  extractEntities(text: string): string[] {
    const entities: string[] = [];

    // Known host/node names (configurable pattern)
    if (this.knownHostPattern) {
      const hosts = text.match(this.knownHostPattern);
      if (hosts) entities.push(...hosts.map(m => m.trim()));
    }

    // IP addresses
    const ips = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g);
    if (ips) entities.push(...ips);

    // Technology names (common infrastructure and ML tools)
    const tech = text.match(
      /\b(Qdrant|Redis|MongoDB|FalkorDB|Docker|vLLM|llama\.?cpp|MLX|Tailscale|Nomic|Postgres|MySQL|Kafka|RabbitMQ|Elasticsearch|Nginx|Kubernetes|Prometheus|Grafana)\b/gi
    );
    if (tech) entities.push(...tech);

    // Port references like "port 6333" or ":6333"
    const ports = text.match(/(?:port\s+|:)(\d{4,5})\b/g);
    if (ports) entities.push(...ports.map(p => `port_${p.replace(/\D/g, "")}`));

    // Dates (ISO format)
    const dates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g);
    if (dates) entities.push(...dates);

    return [...new Set(entities)];
  }

  /**
   * Classify entity type from its name/pattern.
   */
  private classifyEntity(entity: string): string {
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(entity)) return "IPAddress";
    if (/^port_\d+/.test(entity)) return "Port";
    if (/^\d{4}-\d{2}-\d{2}$/.test(entity)) return "Date";
    if (this.knownHostPattern && this.knownHostPattern.test(entity)) return "Host";
    if (/^(Qdrant|Redis|MongoDB|FalkorDB|Docker|vLLM|llama|MLX|Tailscale|Nomic|Postgres|MySQL|Kafka|RabbitMQ|Elasticsearch|Nginx|Kubernetes|Prometheus|Grafana)/i.test(entity)) return "Technology";
    return "Concept";
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}
