import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compatibility } from "../compatibility.js";
import type { BridgeMetrics } from "../metrics.js";

export const COS_CONTROL_PROTOCOL = 1 as const;
export const COS_APP_ID = "chat-on-steroids" as const;
export const COS_PROVIDER_EXTENSION_FEATURES = {
  projectResolve: "provider-project-resolve-v1",
  assistantContent: "provider-assistant-content-v1",
  sessionPolicy: "provider-session-policy-v1",
  turnDrain: "provider-turn-drain-v1",
} as const;
export const COS_REQUIRED_ACTION_ROUTES = [
  "POST /v1/inputs",
  "POST /v1/inputs/{id}/cancel",
  "POST /v1/sessions/{id}/stop",
] as const;

export interface CosProviderExtensionIdentity {
  readonly apiVersion: 1;
  readonly buildId: string;
}

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

  constructor(code: CosErrorCode, message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message);
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
  readonly providerExtension?: CosProviderExtensionIdentity | undefined;
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

export type CosProviderTurnState = "admitted" | "active" | "closing" | "drained" | "not_sent" | "broken";

export interface CosProviderTurnAttestation {
  readonly inputId: string;
  readonly state: CosProviderTurnState;
  readonly turnId: string | null;
  readonly drainedSeq: number | null;
  readonly finalAssistantSeq: number | null;
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
  readonly providerTurn?: CosProviderTurnAttestation | undefined;
}

export interface CosEvent {
  readonly seq: number;
  readonly position: number;
  readonly time: number;
  readonly kind: string;
  readonly source: string;
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
  readonly sseBackoffs: number;
  readonly assistantContentBytes: number;
  readonly assistantContentRequests: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 500,
};
const PROVIDER_EXTENSION_READINESS_TTL_MS = 1_000;
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

function nullableString(value: unknown, context: string): string | null {
  if (value === null) return null;
  return asString(value, context);
}

function nullablePositiveInteger(value: unknown, context: string): number | null {
  if (value === null) return null;
  const number = asNumber(value, context);
  if (!Number.isSafeInteger(number) || number < 1) throw new CosControllerError("schema_mismatch", `${context} must be a positive integer or null`);
  return number;
}

function parseProviderTurn(value: unknown, context: string): CosProviderTurnAttestation | undefined {
  if (value === undefined || value === null) return undefined;
  const row = asRecord(value, context);
  const state = asString(row.state, `${context}.state`);
  if (!["admitted", "active", "closing", "drained", "not_sent", "broken"].includes(state)) {
    throw new CosControllerError("schema_mismatch", `${context}.state is invalid`);
  }
  return {
    inputId: asString(row.inputId, `${context}.inputId`),
    state: state as CosProviderTurnState,
    turnId: nullableString(row.turnId, `${context}.turnId`),
    drainedSeq: nullablePositiveInteger(row.drainedSeq, `${context}.drainedSeq`),
    finalAssistantSeq: nullablePositiveInteger(row.finalAssistantSeq, `${context}.finalAssistantSeq`),
  };
}

function parseProviderExtensionIdentity(value: unknown): CosProviderExtensionIdentity | undefined {
  if (value === undefined || value === null) return undefined;
  const row = asRecord(value, "health.providerExtension");
  if (row.apiVersion !== 1) {
    throw new CosControllerError("schema_mismatch", "health.providerExtension.apiVersion must be 1");
  }
  const buildId = asString(row.buildId, "health.providerExtension.buildId");
  if (!/^[0-9a-f]{40}$/i.test(buildId) && buildId !== "development") {
    throw new CosControllerError("schema_mismatch", "health.providerExtension.buildId must be a Git SHA or development");
  }
  return { apiVersion: 1, buildId: buildId.toLowerCase() };
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
    providerExtension: parseProviderExtensionIdentity(row.providerExtension),
  };
}

export function validateProviderExtensionReadiness(readiness: CosControllerReadiness): CosControllerReadiness {
  for (const [feature, version] of Object.entries(compatibility.cos.providerExtension.features)) {
    if (readiness.features[feature] !== version) {
      throw new CosControllerError("provider_extension_unavailable", `Required CoS provider extension feature is unavailable: ${feature}`);
    }
  }
  if (!readiness.providerExtension
    || readiness.providerExtension.apiVersion !== compatibility.cos.providerExtension.apiVersion
    || readiness.providerExtension.buildId !== compatibility.cos.providerExtension.buildId) {
    throw new CosControllerError("provider_extension_unavailable", "Required CoS provider extension build identity is unavailable");
  }
  return readiness;
}

export function missingRequiredActionRoutes(readiness: CosControllerReadiness): readonly (typeof COS_REQUIRED_ACTION_ROUTES)[number][] {
  return COS_REQUIRED_ACTION_ROUTES.filter((route) => !readiness.actionRoutes.includes(route));
}

export function validateProductionControllerReadiness(readiness: CosControllerReadiness): CosControllerReadiness {
  validateProviderExtensionReadiness(readiness);
  for (const route of COS_REQUIRED_ACTION_ROUTES) {
    if (!readiness.actionRoutes.includes(route)) {
      throw new CosControllerError("provider_extension_unavailable", `Required CoS controller action route is unavailable: ${route}`);
    }
  }
  return readiness;
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
  } catch {
    throw new CosControllerError("controller_unavailable", "CoS control API discovery files are unavailable", {
      retryable: true,
    });
  }

  let parsedEndpoint: unknown;
  try {
    parsedEndpoint = JSON.parse(endpointRaw);
  } catch {
    throw new CosControllerError("schema_mismatch", "endpoint.json is malformed JSON");
  }
  const endpoint = asRecord(parsedEndpoint, "endpoint.json");
  const endpointProtocol = endpoint.protocol;
  if (endpointProtocol !== undefined && endpointProtocol !== COS_CONTROL_PROTOCOL) {
    throw new CosControllerError("protocol_mismatch", `Unsupported CoS control protocol ${String(endpointProtocol)}`);
  }
  const explicitBaseUrl = optionalString(endpoint.url ?? endpoint.baseUrl ?? endpoint.endpoint, "endpoint url");
  const endpointPort = endpoint.port;
  let baseUrl = explicitBaseUrl;
  if (!baseUrl && endpointPort !== undefined) {
    if (!Number.isSafeInteger(endpointPort) || (endpointPort as number) < 1 || (endpointPort as number) > 65_535) {
      throw new CosControllerError("schema_mismatch", "endpoint.json port must be an integer from 1 through 65535");
    }
    baseUrl = `http://127.0.0.1:${endpointPort as number}`;
  }
  if (!baseUrl) {
    throw new CosControllerError("schema_mismatch", "endpoint.json does not contain a controller URL or port");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new CosControllerError("schema_mismatch", "endpoint.json controller URL is invalid");
  }
  if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "::1")) {
    throw new CosControllerError("schema_mismatch", "controller endpoint must be loopback HTTP");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new CosControllerError("schema_mismatch", "controller endpoint must be a credential-free loopback origin");
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
  const wireCode = row && typeof (row.error ?? row.code) === "string" ? String(row.error ?? row.code) : undefined;
  if (status === 403 && wireCode === "actions_disabled") return new CosControllerError("actions_disabled", "CoS controller actions are disabled", { status });
  if (status === 401 || status === 403) return new CosControllerError("controller_auth_changed", "CoS controller authentication changed", { retryable: true, status });
  if (status === 429) return new CosControllerError("rate_limited", "CoS controller rate limited the request", { retryable: true, status });
  if (status === 503 && wireCode === "busy") return new CosControllerError("request_failed", "CoS controller read capacity is temporarily busy", { retryable: true, status });
  if (status === 504 && wireCode === "timeout") return new CosControllerError("request_failed", "CoS controller read timed out while its owner was still working", { retryable: true, status });
  if (status === 404 && wireCode === "session_not_found") return new CosControllerError("request_failed", "CoS session projection is not readable yet", { retryable: true, status });
  if (status === 503 && wireCode === "queue_full") return new CosControllerError("queue_full", "CoS controller action queue is full", { retryable: true, status });
  if (status === 404 && wireCode === "project_unmapped") return new CosControllerError("project_unmapped", "No exact usable CoS project matches the requested canonical path", { status });
  if (status === 409 && wireCode === "provider_policy_unavailable") return new CosControllerError("provider_policy_unavailable", "Required CoS provider-session policy is unavailable", { status });
  return new CosControllerError("request_failed", `CoS controller request failed with HTTP ${status}`, { status });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CosControllerClient {
  private discovery: CosControllerDiscovery | undefined;
  private providerExtensionReadiness: { readonly value: CosControllerReadiness; readonly expiresAt: number } | undefined;
  private readonly activeEventStreams = new Map<string, Set<AbortController>>();
  private metricsState = {
    readAttempts: 0,
    readRetries: 0,
    sseConnectAttempts: 0,
    sseReconnects: 0,
    sseBackoffs: 0,
    assistantContentBytes: 0,
    assistantContentRequests: 0,
  };

  constructor(
    private readonly discover: () => Promise<CosControllerDiscovery>,
    private readonly transport: CosControllerTransport = { fetch: globalThis.fetch.bind(globalThis) },
    private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
    private readonly bridgeMetrics?: BridgeMetrics,
  ) {}

  private async getDiscovery(force = false): Promise<CosControllerDiscovery> {
    if (force) {
      this.discovery = undefined;
      this.providerExtensionReadiness = undefined;
    }
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
      const method = String(init.method ?? "GET").toUpperCase();
      this.bridgeMetrics?.increment(method === "GET" ? "controllerReadCount" : "controllerActionCount");
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
          this.providerExtensionReadiness = undefined;
          lastError = mapped;
          continue;
        }
        throw mapped;
      } catch (cause) {
        if (cause instanceof CosControllerError) throw cause;
        lastError = cause;
        if (attempt >= maxAttempts) {
          throw new CosControllerError("controller_unavailable", "CoS controller request failed", { retryable: true });
        }
        const delay = Math.min(this.retryPolicy.baseDelayMs * 2 ** (attempt - 1), this.retryPolicy.maxDelayMs);
        this.bridgeMetrics?.increment("backoffCount");
        await sleep(delay);
      }
    }
    void lastError;
    throw new CosControllerError("controller_unavailable", "CoS controller request failed", { retryable: true });
  }

  private async readJson(path: string): Promise<unknown> {
    const response = await this.request(path, { method: "GET" }, { retryRead: true });
    try {
      return await response.json();
    } catch {
      throw new CosControllerError("schema_mismatch", "CoS controller returned malformed JSON");
    }
  }

  async health(): Promise<CosControllerReadiness> {
    return parseHealth(await this.readJson("/v1/health"));
  }

  async requireProviderExtension(): Promise<CosControllerReadiness> {
    // This is the production admission readiness boundary. Never reuse a previous success:
    // actions, action-route surface and extension provenance can all change after a CoS restart
    // or token rotation even when a prior health snapshot is still recent.
    this.providerExtensionReadiness = undefined;
    const readiness = validateProductionControllerReadiness(await this.health());
    this.providerExtensionReadiness = {
      value: readiness,
      expiresAt: Date.now() + PROVIDER_EXTENSION_READINESS_TTL_MS,
    };
    return readiness;
  }

  private async requireProviderExtensionWithinAdmission(): Promise<CosControllerReadiness> {
    const now = Date.now();
    if (this.providerExtensionReadiness && this.providerExtensionReadiness.expiresAt > now) {
      return this.providerExtensionReadiness.value;
    }
    return this.requireProviderExtension();
  }

  async resolveProject(path: string): Promise<CosResolvedProject> {
    await this.requireProviderExtensionWithinAdmission();
    const response = await this.request("/v1/projects/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new CosControllerError("schema_mismatch", "project resolve response is malformed JSON");
    }
    const row = asRecord(value, "project resolve response");
    return {
      projectId: asString(row.projectId, "project resolve response.projectId"),
      name: asString(row.name, "project resolve response.name"),
      canonicalPath: asString(row.canonicalPath, "project resolve response.canonicalPath"),
    };
  }

  async assistantContentChunk(sessionId: string, seq: number, offset = 0, limit = 16_384): Promise<CosAssistantContentChunk> {
    await this.requireProviderExtensionWithinAdmission();
    if (!Number.isInteger(seq) || seq < 1 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 2 || limit > 65_536) {
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

  async *assistantContentChunks(sessionId: string, seq: number, chunkSize = 16_384): AsyncGenerator<CosAssistantContentChunk> {
    let offset = 0;
    let expectedTotal: number | undefined;
    for (;;) {
      const chunk = await this.assistantContentChunk(sessionId, seq, offset, chunkSize);
      if (chunk.sessionId !== sessionId || chunk.seq !== seq || chunk.offset !== offset) {
        throw new CosControllerError("schema_mismatch", "assistant content chunk identity/range mismatch");
      }
      if (expectedTotal === undefined) expectedTotal = chunk.totalLength;
      if (chunk.totalLength !== expectedTotal) throw new CosControllerError("schema_mismatch", "assistant content totalLength changed during retrieval");
      offset += chunk.text.length;
      if (offset > expectedTotal) throw new CosControllerError("schema_mismatch", "assistant content exceeded declared totalLength");
      if (!chunk.complete && chunk.text.length === 0) {
        throw new CosControllerError("schema_mismatch", "assistant content returned an empty nonterminal chunk");
      }
      yield chunk;
      if (chunk.complete) {
        if (offset !== expectedTotal) throw new CosControllerError("schema_mismatch", "assistant content completed before declared totalLength");
        return;
      }
    }
  }

  async fullAssistantContent(sessionId: string, seq: number, chunkSize = 16_384): Promise<string> {
    let result = "";
    for await (const chunk of this.assistantContentChunks(sessionId, seq, chunkSize)) {
      result += chunk.text;
    }
    return result;
  }

  async session(sessionId: string): Promise<CosSessionSummary> {
    const envelope = asRecord(await this.readJson(`/v1/sessions/${encodeURIComponent(sessionId)}`), "session response");
    const row = asRecord(envelope.session ?? envelope, "session");
    return {
      id: asString(row.id, "session.id"),
      activeTurnId: row.activeTurnId === null ? null : optionalString(row.activeTurnId, "session.activeTurnId"),
      providerPolicy: parseProviderPolicy(row.providerPolicy, "session.providerPolicy"),
      providerTurn: parseProviderTurn(row.providerTurn, "session.providerTurn"),
    };
  }

  async requireBackgroundWorkDisabled(sessionId: string): Promise<CosProviderSessionPolicyAttestation> {
    await this.requireProviderExtensionWithinAdmission();
    const session = await this.session(sessionId);
    if (!session.providerPolicy) {
      throw new CosControllerError("provider_policy_unavailable", "CoS session does not attest enforced backgroundWork=disabled");
    }
    return session.providerPolicy;
  }

  async input(inputId: string): Promise<CosInputRecord | undefined> {
    const value = await this.readJson("/v1/inputs?limit=500");
    const rows = asRecord(value, "inputs").inputs;
    if (!Array.isArray(rows)) throw new CosControllerError("schema_mismatch", "inputs response must contain an inputs array");
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
    const rows = asRecord(value, "events").events;
    if (!Array.isArray(rows)) throw new CosControllerError("schema_mismatch", "events response must contain an events array");
    return rows.map((entry, index) => {
      const row = asRecord(entry, `events[${index}]`);
      return {
        ...row,
        seq: asNumber(row.seq, `events[${index}].seq`),
        position: asNumber(row.position, `events[${index}].position`),
        time: asNumber(row.time, `events[${index}].time`),
        kind: asString(row.kind, `events[${index}].kind`),
        source: asString(row.source, `events[${index}].source`),
        turnId: optionalString(row.turnId, `events[${index}].turnId`),
      };
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
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new CosControllerError("schema_mismatch", "send response is malformed JSON");
      }
      const envelope = asRecord(value, "send response");
      if (typeof envelope.replayed !== "boolean") throw new CosControllerError("schema_mismatch", "send response.replayed must be boolean");
      const row = asRecord(envelope.input, "send response.input");
      const delivery = asString(row.delivery, "send response.input.delivery");
      if (!["pending", "sent", "not_sent", "unconfirmed"].includes(delivery)) {
        throw new CosControllerError("schema_mismatch", `Unknown input delivery state ${delivery}`);
      }
      return {
        id: asString(row.id, "send response.input.id"),
        sessionId: optionalString(row.sessionId, "send response.input.sessionId"),
        delivery: delivery as NonNullable<CosInputRecord["delivery"]>,
      };
    } catch (cause) {
      if (cause instanceof CosControllerError && !["controller_unavailable", "controller_auth_changed", "request_failed"].includes(cause.code)) throw cause;
      const existing = await this.input(input.id);
      if (existing) return existing;
      throw new CosControllerError("delivery_unconfirmed", "Input delivery could not be confirmed after an ambiguous send failure");
    }
  }

  async cancelPendingInput(inputId: string): Promise<void> {
    const response = await this.request(`/v1/inputs/${encodeURIComponent(inputId)}/cancel`, { method: "POST" });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new CosControllerError("schema_mismatch", "pending-input cancel response is malformed JSON");
    }
    const row = asRecord(value, "pending-input cancel response");
    if (row.ok !== true) throw new CosControllerError("schema_mismatch", "pending-input cancel response.ok must be true");
  }

  async requestStopExactTurn(sessionId: string, turnId: string): Promise<void> {
    // Stop is commonly the first action after a long-running turn. CoS can restart and rotate
    // both controller discovery files while the bridge process stays alive, so do not let a
    // cached endpoint/token send an exact-turn Stop to the retired controller instance. Repeating
    // Stop for the same exact turn is safe; never substitute a new turn or replay its input.
    const maxAttempts = Math.max(1, Math.min(3, this.retryPolicy.maxAttempts));
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      this.discovery = undefined;
      this.providerExtensionReadiness = undefined;
      try {
        const response = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnId }),
        });
        if (response.status !== 202) throw new CosControllerError("schema_mismatch", "Stop response status must be 202");
        let value: unknown;
        try {
          value = await response.json();
        } catch {
          throw new CosControllerError("schema_mismatch", "Stop response is malformed JSON");
        }
        asRecord(value, "Stop response");
        // The stream reader may currently be blocked waiting for its next event. Wake only this
        // session's stream after the controller has accepted Stop; it reconnects internally from
        // the saved cursor and does not terminate the ACP request or release its lease.
        this.reconnectEventStreams(sessionId, "sse_stop_reconnect");
        return;
      } catch (cause) {
        lastError = cause;
        this.discovery = undefined;
        this.providerExtensionReadiness = undefined;
        // Even an ambiguous/non-retryable Stop response may follow a dispatched action. Wake the
        // stream to reconcile recorded events, but keep the error visible and never infer success.
        this.reconnectEventStreams(sessionId, "sse_stop_retry_reconnect");
        if (cause instanceof CosControllerError && !cause.retryable) throw cause;
        // A failed action may have reached the controller before its response was lost. Retry only
        // the same exact turn id; Stop is idempotent for that target and never sends another input.
        if (attempt + 1 >= maxAttempts) throw cause;
        const delay = Math.min(this.retryPolicy.baseDelayMs * 2 ** attempt, this.retryPolicy.maxDelayMs);
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new CosControllerError("controller_unavailable", "CoS controller Stop failed", { retryable: true });
  }

  private reconnectEventStreams(sessionId: string, reason: string): void {
    for (const controller of this.activeEventStreams.get(sessionId) ?? []) {
      if (!controller.signal.aborted) controller.abort(new Error(reason));
    }
  }

  async stopExactTurn(sessionId: string, turnId: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<CosEvent> {
    await this.requestStopExactTurn(sessionId, turnId);

    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    while (Date.now() < deadline) {
      const rows = await this.events(sessionId, cursor || undefined);
      for (const event of rows) {
        cursor = Math.max(cursor, event.seq + 1);
        if (event.kind === "turn_end" && event.turnId === turnId) return event;
      }
      await sleep(pollMs);
    }
    throw new CosControllerError("turn_cancel_requested", `Stop was requested for turn ${turnId}, but matching turn_end was not observed`, { retryable: true });
  }

  async *streamEvents(sessionId: string, options: {
    from?: number;
    signal?: AbortSignal;
    rolloverMs?: number;
    idleTimeoutMs?: number;
  } = {}): AsyncGenerator<CosEvent> {
    let cursor = options.from;
    let connectedOnce = false;
    let reconnectAttempt = 0;
    const rolloverMs = options.rolloverMs ?? 29 * 60_000;
    // The CoS server sends an SSE comment heartbeat every 15 seconds. If its process dies while
    // a socket remains half-open, those heartbeats stop but reader.read() may not reject promptly.
    // Bound that dead connection so a long-lived bridge can discover the restarted endpoint/token.
    const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
    while (!options.signal?.aborted) {
      let streamController: AbortController | undefined;
      let onAbort: (() => void) | undefined;
      let rolloverTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<string> | undefined;
      try {
        // Every reconnect is a new controller boundary: the app may have restarted and rotated its
        // endpoint/token even when the previous stream ended without an HTTP error. Discovery can
        // also be briefly unavailable while the restarted process republishes its files; retry it
        // under the same bounded backoff instead of terminating the provider driver.
        const discovery = await this.getDiscovery(connectedOnce);
        const headers = new Headers({ Accept: "text/event-stream", Authorization: `Bearer ${discovery.token}` });
        if (cursor !== undefined) headers.set("Last-Event-ID", String(Math.max(0, cursor - 1)));
        this.metricsState.sseConnectAttempts += 1;
        if (connectedOnce) this.metricsState.sseReconnects += 1;
        this.bridgeMetrics?.increment("sseConnectCount");
        if (connectedOnce) this.bridgeMetrics?.increment("sseReconnectCount");
        const suffix = cursor === undefined ? "" : `?from=${encodeURIComponent(String(cursor))}`;
        streamController = new AbortController();
        let sessionStreams = this.activeEventStreams.get(sessionId);
        if (!sessionStreams) {
          sessionStreams = new Set<AbortController>();
          this.activeEventStreams.set(sessionId, sessionStreams);
        }
        sessionStreams.add(streamController);
        onAbort = () => streamController!.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        rolloverTimer = setTimeout(() => {
          this.discovery = undefined;
          this.providerExtensionReadiness = undefined;
          streamController!.abort(new Error("sse_rollover"));
        }, rolloverMs);
        const resetIdleTimer = (): void => {
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            this.discovery = undefined;
            this.providerExtensionReadiness = undefined;
            streamController!.abort(new Error("sse_idle_timeout"));
          }, idleTimeoutMs);
        };
        resetIdleTimer();
        const requestInit: RequestInit = { headers, signal: streamController.signal };
        const response = await this.transport.fetch(`${discovery.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events/stream${suffix}`, requestInit);
        if (!response.ok) throw mapHttpError(response.status, undefined);
        if (!response.body) throw new CosControllerError("controller_unavailable", "SSE response has no body", { retryable: true });
        connectedOnce = true;
        reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        let sawEvent = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.length > 0) resetIdleTimer();
          buffer += value;
          let boundary: number;
          for (;;) {
            const lf = buffer.indexOf("\n\n");
            const crlf = buffer.indexOf("\r\n\r\n");
            if (lf < 0 && crlf < 0) break;
            const useCrlf = crlf >= 0 && (lf < 0 || crlf < lf);
            boundary = useCrlf ? crlf : lf;
            const separatorLength = useCrlf ? 4 : 2;
            const frame = buffer.slice(0, boundary).replace(/\r/g, "");
            buffer = buffer.slice(boundary + separatorLength);
            let id: number | undefined;
            let eventName: string | undefined;
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("id:")) id = Number(line.slice(3).trim());
              else if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) continue;
            // CoS uses an unnumbered `event: end` control frame to retire an SSE connection
            // (max lifetime, controller stop/error, slow consumer, etc.). It is not a session
            // event and therefore has no seq/position/time/kind/source fields. Treat it as a
            // reconnect boundary; the next request resumes from the exact last event cursor.
            if (eventName === "end") continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(dataLines.join("\n"));
            } catch {
              throw new CosControllerError("schema_mismatch", "SSE event data is malformed JSON");
            }
            const row = asRecord(parsed, "SSE event");
            const event: CosEvent = {
              ...row,
              seq: asNumber(row.seq ?? id, "SSE event.seq"),
              position: asNumber(row.position, "SSE event.position"),
              time: asNumber(row.time, "SSE event.time"),
              kind: asString(row.kind, "SSE event.kind"),
              source: asString(row.source, "SSE event.source"),
              turnId: optionalString(row.turnId, "SSE event.turnId"),
            };
            cursor = event.seq + 1;
            sawEvent = true;
            yield event;
          }
        }
        if (rolloverTimer !== undefined) clearTimeout(rolloverTimer);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        options.signal?.removeEventListener("abort", onAbort);
        if (options.signal?.aborted) return;
        reconnectAttempt = sawEvent ? 0 : reconnectAttempt + 1;
        this.metricsState.sseBackoffs += 1;
        this.bridgeMetrics?.increment("backoffCount");
        const exponential = Math.min(this.retryPolicy.baseDelayMs * 2 ** Math.max(0, reconnectAttempt - 1), this.retryPolicy.maxDelayMs);
        const jitter = Math.floor(exponential * 0.2 * Math.random());
        await sleep(Math.min(this.retryPolicy.maxDelayMs, exponential + jitter));
      } catch (cause) {
        if (options.signal?.aborted) return;
        if (cause instanceof CosControllerError && cause.code !== "controller_auth_changed" && !cause.retryable) throw cause;
        // Every failed stream attempt must discard discovery: even a clean-looking transport
        // failure may be the old controller disappearing during a restart/token rotation.
        this.discovery = undefined;
        this.providerExtensionReadiness = undefined;
        reconnectAttempt += 1;
        this.metricsState.sseBackoffs += 1;
        this.bridgeMetrics?.increment("backoffCount");
        const exponential = Math.min(
          this.retryPolicy.baseDelayMs * 2 ** Math.max(0, reconnectAttempt - 1),
          this.retryPolicy.maxDelayMs,
        );
        const jitter = Math.floor(exponential * 0.2 * Math.random());
        await sleep(Math.min(this.retryPolicy.maxDelayMs, exponential + jitter));
      } finally {
        if (rolloverTimer !== undefined) clearTimeout(rolloverTimer);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
        // A provider-turn consumer normally returns as soon as the authoritative drain has been
        // emitted and acknowledged. Async-generator return does not automatically cancel this
        // nested fetch body, so without an explicit finally every completed turn can leave one
        // held CoS event stream behind until its 30-minute server lifetime expires. Closing both
        // sides here frees the controller's bounded stream slot immediately on terminal return.
        if (streamController && !streamController.signal.aborted) streamController.abort(new Error("sse_consumer_closed"));
        if (reader) {
          try { await reader.cancel(); } catch { /* the abort above may already have closed it */ }
          try { reader.releaseLock(); } catch { /* an already-closed reader may have no lock */ }
        }
        if (streamController) {
          const sessionStreams = this.activeEventStreams.get(sessionId);
          sessionStreams?.delete(streamController);
          if (sessionStreams?.size === 0) this.activeEventStreams.delete(sessionId);
        }
      }
    }
  }
}
