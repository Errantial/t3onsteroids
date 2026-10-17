import { createHash } from "node:crypto";

export interface BridgeLogRecord {
  readonly timestamp: number;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly operation: string;
  readonly correlationId?: string;
  readonly acpSession?: string;
  readonly cosSession?: string;
  readonly transition?: string;
  readonly status?: number;
  readonly errorCategory?: string;
  readonly latencyMs?: number;
  readonly byteCount?: number;
  readonly queueDepth?: number;
}

const OPERATIONS = new Set(["provider_prompt", "controller_read", "controller_action", "sse_stream", "provider_turn"]);
const TRANSITIONS = new Set(["input_accepted", "turn_end", "turn_drained", "terminal_sent", "cancelled_not_sent"]);
const ERROR_CATEGORIES = new Set([
  "controller_unavailable",
  "controller_auth_changed",
  "actions_disabled",
  "queue_full",
  "rate_limited",
  "delivery_unconfirmed",
  "project_unmapped",
  "provider_policy_unavailable",
  "provider_extension_unavailable",
  "schema_mismatch",
  "protocol_mismatch",
  "request_failed",
  "session_broken",
  "internal_error",
]);

function allowlisted(value: string | undefined, allowed: ReadonlySet<string>): string | undefined {
  return value !== undefined && allowed.has(value) ? value : undefined;
}

function shortId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function bridgeLogRecord(input: {
  readonly level: BridgeLogRecord["level"];
  readonly operation: string;
  readonly correlationId?: string;
  readonly acpSessionId?: string;
  readonly cosSessionId?: string;
  readonly transition?: string;
  readonly status?: number;
  readonly errorCategory?: string;
  readonly latencyMs?: number;
  readonly byteCount?: number;
  readonly queueDepth?: number;
  readonly now?: number;
}): BridgeLogRecord {
  const operation = allowlisted(input.operation, OPERATIONS) ?? "provider_turn";
  const transition = allowlisted(input.transition, TRANSITIONS);
  const errorCategory = allowlisted(input.errorCategory, ERROR_CATEGORIES);
  return {
    timestamp: input.now ?? Date.now(),
    level: input.level,
    operation,
    ...(input.correlationId ? { correlationId: shortId(input.correlationId) } : {}),
    ...(input.acpSessionId ? { acpSession: shortId(input.acpSessionId) } : {}),
    ...(input.cosSessionId ? { cosSession: shortId(input.cosSessionId) } : {}),
    ...(transition ? { transition } : {}),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(errorCategory ? { errorCategory } : {}),
    ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
    ...(input.byteCount === undefined ? {} : { byteCount: input.byteCount }),
    ...(input.queueDepth === undefined ? {} : { queueDepth: input.queueDepth }),
  };
}
