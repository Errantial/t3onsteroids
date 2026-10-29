# Provider usage contract (draft)

Status: **draft, not implemented.** Backs PLAN.md post-v1 items 1 (usage page) and 2 (tokens/sec). Nothing here is advertised or enabled until CoS reports a matching feature and the pinned tuple is requalified.

## Why a contract is needed

Audit of pinned T3 `ffb4af8d` (details in PLAN.md item 1):

- T3's `/usage` page only knows seven provider kinds and derives usage from provider transcripts and quota probes. A CoS-backed ACP thread has neither.
- T3's generic ACP adapter maps only `usage_update` (`used`, `size`, optional `cost`) into context-window state. It does **not** produce per-turn `TurnTokenUsage`, so the tokens/sec patch shows nothing for any ACP provider today, independent of CoS.
- ACP `PromptResponse.usage` (`totalTokens`, `inputTokens`, `outputTokens`, ...) is marked UNSTABLE in SDK 1.9.0 and is cumulative across the session, not per turn.
- CoS drives a ChatGPT browser chat. Whether it can know authoritative token counts, message counts or plan-limit windows is **unverified**; the first task is to inspect the CoS controller source (base `87ae9d63`, plus the provider-extension patches) for what it actually observes.

## Contract shape (proposed)

A new controller feature `provider-usage-v1: 1`, advertised on `/v1/health` like the existing provider extensions. Read-only, authenticated, same Host/Origin/rate rules as protocol 1.

```text
GET /v1/sessions/{sessionId}/usage
→ {
    "turns": [ { "turnId": "...", "inputId": "...", "outputTokens": 123 | null,
                 "inputTokens": 456 | null, "source": "reported" } ],
    "subscription": { "status": "available" | "unavailable",
                      "windows": [ { "id": "...", "kind": "session"|"weekly"|"monthly"|"other",
                                     "label": "...", "usedPercent": 0..100,
                                     "resetsAt": "ISO-8601"|null } ] }
  }
```

Rules:

- Every figure is `reported` by CoS from something it observed. No estimates, no character-count proxies; an unknown value is `null` and an unavailable subscription is `status:"unavailable"`.
- Turn rows are keyed by the same `(turnId, inputId)` identity as `turn_drained`, and are immutable once the turn is drained.
- No prompt text, tool bodies, tokens or raw configuration cross this route.
- Subscription windows reuse the shape of T3's `ServerProviderUsageWindow` so no translation is needed.

## Bridge and T3 mapping

1. Bridge: after `turn_drained` and before resolving `session/prompt`, read the turn's usage row and attach it to the ACP result as per-turn usage (ACP `PromptResponse.usage` only if the per-turn versus cumulative semantics are made explicit; otherwise `_meta`, which clients must not interpret, is not enough on its own).
2. T3 patch (second in the series, not yet written): in the ACP adapter, map per-turn output/input tokens into `TurnTokenUsage` with `usageStatus:"complete"` only when both are reported, which also enables the tokens/sec readout for ACP providers.
3. T3 patch (third): register the CoS provider on the `/usage` page with subscription windows if the controller reports them, otherwise show the page's existing unavailable state.

## Open questions

- What CoS can observe at all (token counts, message counts, plan caps). Decides whether items 2 and 3 above are worthwhile for CoS or only for other ACP providers.
- Per-turn versus cumulative semantics for ACP usage, and whether to carry them in a stable field or a namespaced `_meta` key with a versioned contract.
- Whether the usage page's `UsageProviderKind` can accept a non-enumerated provider without a schema change (it is a closed literal union today), or needs a forward-compatible variant in the patch.
