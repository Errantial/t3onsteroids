import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const COS_CONTROL_PROTOCOL = 1 as const;
export const COS_APP_ID = "chat-on-steroids" as const;
export const COS_PROVIDER_EXTENSION_FEATURES = {
  projectResolve: "provider-project-resolve-v1",
  assistantContent: "provider-assistant-content-v1",
  sessionPolicy: "provider-session-policy-v1",
} as const;

export type CosErrorCode =
  | "controller_unavailable"
  | "controller_auth_changed"
  | "actions_disabled"
  | "queue_full"
  | "rate_limited"
  | "delivery_unconfirmed"
  | "turn_cancel_requested"
  | "project_unmapped"
  | "provider_policy_unavailable"
  | "provider_extension_unavailable"
  | "schema_mismatch"
  | "protocol_mismatch"
  | "request_failed";

export class CosControllerError extends Error {
  readonly code: CosErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(code: CosErrorCode, message: string, options: { retryable?: boolean; status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CosControllerError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export interface CosControllerDiscovery {
  readonly baseUrl: string;
  readonly token: string;
  readonly pid?: number | undefined;
  readonly startedAt?: string | undefined;
}

export interface CosControllerReadiness {
  readonly protocol: number;
  readonly actionsEnabled: boolean;
  readonly actionRoutes: readonly string[];
  readonly app: string;
  readonly features: Readonly<Record<string, number>>;
}

export interface CosResolvedProject {
  readonly projectId: string;
  readonly name: string;
  readonly canonicalPath: string;
}

export interface CosAssistantContentChunk {
  readonly sessionId: string;
  readonly seq: number;
  readonly field: "assistantText";
  readonly offset: number;
  readonly text: string;
  readonly totalLength: number;
  readonly complete: boolean;
}

export interface CosProviderSessionPolicyAttestation {
  readonly backgroundWork: "disabled";
  readonly enforced: true;
}

export interface CosInputRecord {
  readonly id: string;
  readonly sessionId?: string | undefined;
  readonly delivery?: "pending" | "sent" | "not_sent" | "unconfirmed" | undefined;
}

export interface CosSessionSummary {
  readonly id: string;
  readonly activeTurnId?: string | null | undefined;
  readonly providerPolicy?: CosProviderSessionPolicyAttestation | undefined;
}

export interface CosEvent {
  readonly seq: number;
  readonly type: string;
  readonly turnId?: string | undefined;
  readonly [key: string]: unknown;
}

export interface CosSendInput {
  readonly id: string;
  readonly text: string;
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly providerPolicy?: { readonly backgroundWork: "disabled" };
}

export interface CosControllerTransport {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface CosClientMetrics {
  readonly readAttempts: number;
  readonly readRetries: number;
  readonly sseConnectAttempts: number;
  readonly sseReconnects: number;
  readonly assistantContentBytes: number;
  readonly assistantContentRequests: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 500,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CosControllerError("schema_mismatch", `${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new CosControllerError("schema_mismatch", `${context} must be a string`);
  }
  return value;
}

function asNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CosControllerError("schema_mismatch", `${context} must be a finite number`);
  }
  return value;
}

function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, context);
}

function parseFeatureMap(value: unknown): Readonly<Record<string, number>> {
  if (value === undefined) return {};
  const row = asRecord(value, "health.features");
  const result: Record<string, number> = {};
  for (const [key, version] of Object.entries(row)) {
    if (!Number.isInteger(version) || (version as number) < 1) {
      throw new CosControllerError("schema_mismatch", `health.features.${key} must be a positive integer`);
    }
    result[key] = version as number;
  }
  return result;
}

function parseProviderPolicy(value: unknown, context: string): CosProviderSessionPolicyAttestation | undefined {
  if (value === undefined || value === null) return undefined;
  const row = asRecord(value, context);
  if (row.backgroundWork !== "disabled" || row.enforced !== true) {
    throw new CosControllerError("provider_policy_unavailable", `${context} does not attest enforced backgroundWork=disabled`);
  }
  return { backgroundWork: "disabled", enforced: true };
}

export function parseHealth(value: unknown): CosControllerReadiness {
  const row = asRecord(value, "health");
  const actions = asRecord(row.actions, "health.actions");
  const protocol = asNumber(row.protocol, "health.protocol");
  const app = asString(row.app, "health.app");
  if (protocol !== COS_CONTROL_PROTOCOL) {
    throw new CosControllerError("protocol_mismatch", `Unsupported CoS control protocol ${protocol}`);
  }
  if (app !== COS_APP_ID) {
    throw new CosControllerError("protocol_mismatch", `Unexpected CoS app ${app}`);
  }
  if (typeof actions.enabled !== "boolean") {
    throw new CosControllerError("schema_mismatch", "health.actions.enabled must be boolean");
  }
  if (!Array.isArray(actions.routes) || !actions.routes.every((route) => typeof route === "string")) {
    throw new CosControllerError("schema_mismatch", "health.actions.routes must be a string array");
  }
  return {
    protocol,
    app,
    actionsEnabled: actions.enabled,
    actionRoutes: actions.routes,
    features: parseFeatureMap(row.features),
  };
}

export async function discoverCosController(userDataDir: string): Promise<CosControllerDiscovery> {
  const controlDir = join(userDataDir, "control-api");
  let endpointRaw: string;
  let token: string;
  try {
    [endpointRaw, token] = await Promise.all([
      readFile(join(controlDir, "endpoint.json"), "utf8"),
      readFile(join(controlDir, "token"), "utf8"),
    ]);
  } catch (cause) {
    throw new CosControllerError("controller_unavailable", "CoS control API discovery files are unavailable", {
      retryable: true,
      cause,
    });
  }

  const endpoint = asRecord(JSON.parse(endpointRaw), "endpoint.json");
  const baseUrl = optionalString(endpoint.url ?? endpoint.baseUrl ?? endpoint.endpoint, "endpoint url");
  if (!baseUrl) {
    throw new CosControllerError("schema_mismatch", "endpoint.json does not contain a controller URL");
  }
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "::1")) {
    throw new CosControllerError("schema_mismatch", "controller endpoint must be loopback HTTP");
  }

  const trimmedToken = token.trim();
  if (!trimmedToken) {
    throw new CosControllerError("schema_mismatch", "controller token is empty");
  }

  return {
    baseUrl: parsed.href.replace(/\/$/, ""),
    token: trimmedToken,
    pid: typeof endpoint.pid === "number" ? endpoint.pid : undefined,
    startedAt: optionalString(endpoint.startedAt ?? endpoint.startTime, "endpoint start time"),
  };
}

function mapHttpError(status: number, body: unknown): CosControllerError {
  const row = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const wireCode = row && typeof row.code === "string" ? row.code : undefined;
  if (status === 401 || status === 403) return new CosControllerError("controller_auth_changed", "CoS controller authentication changed", { retryable: true, status });
  if (status === 429) return new CosControllerError("rate_limited", "CoS controller rate limited the request", { retryable: true, status });
  if (status === 503 && wireCode === "queue_full") return new CosControllerError("queue_full", "CoS controller action queue is full", { retryable: true, status });
  if (status === 409 && wireCode === "actions_disabled") return new CosControllerError("actions_disabled", "CoS controller actions are disabled", { status });
  if (status === 404 && wireCode === "project_unmapped") return new CosControllerError("project_unmapped", "No exact usable CoS project matches the requested canonical path", { status });
  if (status === 409 && wireCode === "provider_policy_unavailable") return new CosControllerError("provider_policy_unavailable", "Required CoS provider-session policy is unavailable", { status });
  return new CosControllerError("request_failed", `CoS controller request failed with HTTP ${status}`, { status });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CosControllerClient {
  private discovery: CosControllerDiscovery | undefined;
  private metricsState = {
    readAttempts: 0,
    readRetries: 0,
    sseConnectAttempts: 0,
    sseReconnects: 0,
    assistantContentBytes: 0,
    assistantContentRequests: 0,
  };

  constructor(
    private readonly discover: () => Promise<CosControllerDiscovery>,
    private readonly transport: CosControllerTransport = { fetch: globalThis.fetch.bind(globalThis) },
    private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  private async getDiscovery(force = false): Promise<CosControllerDiscovery> {
    if (force || !this.discovery) this.discovery = await this.discover();
    return this.discovery;
  }

  private async request(path: string, init: RequestInit = {}, options: { retryRead?: boolean } = {}): Promise<Response> {
    const maxAttempts = options.retryRead ? this.retryPolicy.maxAttempts : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.retryRead) {
        this.metricsState.readAttempts += 1;
        if (attempt > 1) this.metricsState.readRetries += 1;
      }
      const discovery = await this.getDiscovery(attempt > 1);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${discovery.token}`);
      headers.set("Accept", "application/json");
      try {
        const response = await this.transport.fetch(`${discovery.baseUrl}${path}`, { ...init, headers });
        if (response.ok) return response;
        let body: unknown;
        try {
          body = await response.clone().json();
        } catch {
          body = undefined;
        }
        const mapped = mapHttpError(response.status, body);
        if (mapped.code === "controller_auth_changed" && attempt < maxAttempts) {
          this.discovery = undefined;
          lastError = mapped;
          continue;
        }
        throw mapped;
      } catch (cause) {
        if (cause instanceof CosControllerError) throw cause;
        lastError = cause;
        if (attempt >= maxAttempts) {
          throw new CosControllerError("controller_unavailable", "CoS controller request failed", { retryable: true, cause });
        }
        const delay = Math.min(this.retryPolicy.baseDelayMs * 2 ** (attempt - 1), this.retryPolicy.maxDelayMs);
        await sleep(delay);
      }
    }
    throw new CosControllerError("controller_unavailable", "CoS controller request failed", { retryable: true, cause: lastError });
  }

  private async readJson(path: string): Promise<unknown> {
    const response = await this.request(path, { method: "GET" }, { retryRead: true });
    return response.json();
  }

  async health(): Promise<CosControllerReadiness> {
    return parseHealth(await this.readJson("/v1/health"));
  }

  async requireProviderExtension(): Promise<CosControllerReadiness> {
    const readiness = await this.health();
    for (const feature of Object.values(COS_PROVIDER_EXTENSION_FEATURES)) {
      if (readiness.features[feature] !== 1) {
        throw new CosControllerError("provider_extension_unavailable", `Required CoS provider extension feature is unavailable: ${feature}`);
      }
    }
    return readiness;
  }

  async resolveProject(path: string): Promise<CosResolvedProject> {
    await this.requireProviderExtension();
    const response = await this.request("/v1/projects/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const row = asRecord(await response.json(), "project resolve response");
    return {
      projectId: asString(row.projectId, "project resolve response.projectId"),
      name: asString(row.name, "project resolve response.name"),
      canonicalPath: asString(row.canonicalPath, "project resolve response.canonicalPath"),
    };
  }

  async assistantContentChunk(sessionId: string, seq: number, offset = 0, limit = 16_384): Promise<CosAssistantContentChunk> {
    await this.requireProviderExtension();
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 65_536) {
      throw new CosControllerError("schema_mismatch", "assistant content range is invalid");
    }
    const value = await this.readJson(`/v1/sessions/${encodeURIComponent(sessionId)}/events/${seq}/assistant-content?offset=${offset}&limit=${limit}`);
    this.metricsState.assistantContentRequests += 1;
    const row = asRecord(value, "assistant content");
    const field = asString(row.field, "assistant content.field");
    if (field !== "assistantText") throw new CosControllerError("schema_mismatch", "assistant content field must be assistantText");
    const complete = row.complete;
    if (typeof complete !== "boolean") throw new CosControllerError("schema_mismatch", "assistant content.complete must be boolean");
    const chunk: CosAssistantContentChunk = {
      sessionId: asString(row.sessionId, "assistant content.sessionId"),
      seq: asNumber(row.seq, "assistant content.seq"),
      field: "assistantText",
      offset: asNumber(row.offset, "assistant content.offset"),
      text: asString(row.text, "assistant content.text"),
      totalLength: asNumber(row.totalLength, "assistant content.totalLength"),
      complete,
    };
    this.metricsState.assistantContentBytes += chunk.text.length;
    return chunk;
  }

  metrics(): CosClientMetrics {
    return { ...this.metricsState };
  }

  async fullAssistantContent(sessionId: string, seq: number, chunkSize = 16_384): Promise<string> {
    let offset = 0;
    let expectedTotal: number | undefined;
    let result = "";
    for (;;) {
      const chunk = await this.assistantContentChunk(sessionId, seq, offset, chunkSize);
      if (chunk.sessionId !== sessionId || chunk.seq !== seq || chunk.offset !== offset) {
        throw new CosControllerError("schema_mismatch", "assistant content chunk identity/range mismatch");
      }
      if (expectedTotal === undefined) expectedTotal = chunk.totalLength;
      if (chunk.totalLength !== expectedTotal) throw new CosControllerError("schema_mismatch", "assistant content totalLength changed during retrieval");
      result += chunk.text;
      offset += chunk.text.length;
      if (offset > expectedTotal) throw new CosControllerError("schema_mismatch", "assistant content exceeded declared totalLength");
      if (chunk.complete) {
        if (offset !== expectedTotal) throw new CosControllerError("schema_mismatch", "assistant content completed before declared totalLength");
        return result;
      }
      if (chunk.text.length === 0) throw new CosControllerError("schema_mismatch", "assistant content returned an empty nonterminal chunk");
    }
  }

  async session(sessionId: string): Promise<CosSessionSummary> {
    const row = asRecord(await this.readJson(`/v1/sessions/${encodeURIComponent(sessionId)}`), "session");
    return {
      id: asString(row.id, "session.id"),
      activeTurnId: row.activeTurnId === null ? null : optionalString(row.activeTurnId, "session.activeTurnId"),
      providerPolicy: parseProviderPolicy(row.providerPolicy, "session.providerPolicy"),
    };
  }

  async requireBackgroundWorkDisabled(sessionId: string): Promise<CosProviderSessionPolicyAttestation> {
    await this.requireProviderExtension();
    const session = await this.session(sessionId);
    if (!session.providerPolicy) {
      throw new CosControllerError("provider_policy_unavailable", "CoS session does not attest enforced backgroundWork=disabled");
    }
    return session.providerPolicy;
  }

  async input(inputId: string): Promise<CosInputRecord | undefined> {
    const value = await this.readJson(`/v1/inputs?id=${encodeURIComponent(inputId)}`);
    const rows = Array.isArray(value) ? value : asRecord(value, "inputs").items;
    if (!Array.isArray(rows)) throw new CosControllerError("schema_mismatch", "inputs response must be an array or object with items");
    const match = rows.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).id === inputId);
    if (!match) return undefined;
    const row = asRecord(match, "input");
    const delivery = optionalString(row.delivery, "input.delivery");
    if (delivery !== undefined && !["pending", "sent", "not_sent", "unconfirmed"].includes(delivery)) {
      throw new CosControllerError("schema_mismatch", `Unknown input delivery state ${delivery}`);
    }
    return { id: asString(row.id, "input.id"), sessionId: optionalString(row.sessionId, "input.sessionId"), delivery: delivery as CosInputRecord["delivery"] };
  }

  async events(sessionId: string, from?: number): Promise<readonly CosEvent[]> {
    const suffix = from === undefined ? "" : `?from=${encodeURIComponent(String(from))}`;
    const value = await this.readJson(`/v1/sessions/${encodeURIComponent(sessionId)}/events${suffix}`);
    const rows = Array.isArray(value) ? value : asRecord(value, "events").items;
    if (!Array.isArray(rows)) throw new CosControllerError("schema_mismatch", "events response must be an array or object with items");
    return rows.map((entry, index) => {
      const row = asRecord(entry, `events[${index}]`);
      return { ...row, seq: asNumber(row.seq, `events[${index}].seq`), type: asString(row.type, `events[${index}].type`), turnId: optionalString(row.turnId, `events[${index}].turnId`) };
    });
  }

  private validateMutation(input: CosSendInput): void {
    if (!UUID_RE.test(input.id)) throw new CosControllerError("schema_mismatch", "CoS input id must be a lowercase UUID");
    if (input.text.length > 64_000) throw new CosControllerError("schema_mismatch", "CoS input text exceeds 64,000 characters");
  }

  async send(input: CosSendInput): Promise<CosInputRecord> {
    this.validateMutation(input);
    const readiness = input.providerPolicy ? await this.requireProviderExtension() : await this.health();
    if (!readiness.actionsEnabled) throw new CosControllerError("actions_disabled", "CoS controller actions are disabled");
    if (input.providerPolicy !== undefined && input.providerPolicy.backgroundWork !== "disabled") {
      throw new CosControllerError("provider_policy_unavailable", "Bridge-created provider sessions require backgroundWork=disabled");
    }
    try {
      const response = await this.request("/v1/inputs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const row = asRecord(await response.json(), "send response");
      return { id: asString(row.id ?? input.id, "send.id"), sessionId: optionalString(row.sessionId, "send.sessionId"), delivery: optionalString(row.delivery, "send.delivery") as CosInputRecord["delivery"] };
    } catch (cause) {
      if (cause instanceof CosControllerError && !["controller_unavailable", "controller_auth_changed", "request_failed"].includes(cause.code)) throw cause;
      const existing = await this.input(input.id);
      if (existing) return existing;
      throw new CosControllerError("delivery_unconfirmed", "Input delivery could not be confirmed after an ambiguous send failure", { cause });
    }
  }

  async cancelPendingInput(inputId: string): Promise<void> {
    const response = await this.request(`/v1/inputs/${encodeURIComponent(inputId)}/cancel`, { method: "POST" });
    if (!response.ok) throw mapHttpError(response.status, undefined);
  }

  async stopExactTurn(sessionId: string, turnId: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<CosEvent> {
    const response = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnId }),
    });
    if (response.status !== 202 && !response.ok) throw mapHttpError(response.status, undefined);

    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    while (Date.now() < deadline) {
      const rows = await this.events(sessionId, cursor || undefined);
      for (const event of rows) {
        cursor = Math.max(cursor, event.seq + 1);
        if (event.type === "turn_end" && event.turnId === turnId) return event;
      }
      await sleep(pollMs);
    }
    throw new CosControllerError("turn_cancel_requested", `Stop was requested for turn ${turnId}, but matching turn_end was not observed`, { retryable: true });
  }

  async *streamEvents(sessionId: string, options: { from?: number; signal?: AbortSignal } = {}): AsyncGenerator<CosEvent> {
    let cursor = options.from;
    let connectedOnce = false;
    while (!options.signal?.aborted) {
      const discovery = await this.getDiscovery();
      const headers = new Headers({ Accept: "text/event-stream", Authorization: `Bearer ${discovery.token}` });
      if (cursor !== undefined) headers.set("Last-Event-ID", String(Math.max(0, cursor - 1)));
      try {
        this.metricsState.sseConnectAttempts += 1;
        if (connectedOnce) this.metricsState.sseReconnects += 1;
        const suffix = cursor === undefined ? "" : `?from=${encodeURIComponent(String(cursor))}`;
        const requestInit: RequestInit = { headers };
        if (options.signal) requestInit.signal = options.signal;
        const response = await this.transport.fetch(`${discovery.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events/stream${suffix}`, requestInit);
        if (!response.ok) throw mapHttpError(response.status, undefined);
        if (!response.body) throw new CosControllerError("controller_unavailable", "SSE response has no body", { retryable: true });
        connectedOnce = true;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary).replace(/\r/g, "");
            buffer = buffer.slice(boundary + 2);
            let id: number | undefined;
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("id:")) id = Number(line.slice(3).trim());
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) continue;
            const row = asRecord(JSON.parse(dataLines.join("\n")), "SSE event");
            const event: CosEvent = {
              ...row,
              seq: asNumber(row.seq ?? id, "SSE event.seq"),
              type: asString(row.type, "SSE event.type"),
              turnId: optionalString(row.turnId, "SSE event.turnId"),
            };
            cursor = event.seq + 1;
            yield event;
          }
        }
      } catch (cause) {
        if (options.signal?.aborted) return;
        if (cause instanceof CosControllerError && cause.code === "controller_auth_changed") this.discovery = undefined;
        else if (!(cause instanceof CosControllerError) && cause instanceof Error && cause.name === "AbortError") return;
        else if (!(cause instanceof CosControllerError) || !cause.retryable) {
          if (cause instanceof CosControllerError) throw cause;
          this.discovery = undefined;
        }
        await sleep(this.retryPolicy.baseDelayMs);
      }
    }
  }
}
