/** Shared HTTP settings for the remote memory backend. */
export interface HttpOptions {
  apiKey?: string;
  timeoutMs?: number;
}

export class QdrantHttpError extends Error {
  constructor(readonly status: number, method: string, path: string) {
    // Do not include response bodies: a proxy may echo credentials or memory text.
    super(`Qdrant ${method} ${path}: HTTP ${status}`);
    this.name = "QdrantHttpError";
  }
}

export async function qdrantRequest(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  options: HttpOptions = {},
  allowedStatuses: number[] = [],
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (options.apiKey) headers.set("api-key", options.apiKey);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    throw new QdrantHttpError(response.status, init.method ?? "GET", path);
  }
  return response;
}
