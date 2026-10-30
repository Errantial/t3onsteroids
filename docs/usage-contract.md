# Provider usage contract (draft)

Status: **parked.** Decision: the ChatGPT/CoS provider is left out of tokens/sec and usage for now (the readout and usage work target other providers). This contract is kept for when that is revisited; nothing below is scheduled. Until then the bridge must report no usage, which `test/no-usage-reporting.test.ts` enforces.

Original status: **draft, not implemented.** Backs PLAN.md post-v1 items 1 (usage page) and 2 (tokens/sec). Nothing here is advertised until CoS reports a matching feature and the pinned tuple is requalified.

## What CoS can actually report (source review, CoS base `87ae9d63`)

From `src/main/session/usage.ts`, `src/shared/usage.ts` and `src/main/usage-tool.ts`:

| Data | Source | Authoritative? |
| --- | --- | --- |
| ChatGPT limit rows: `model`, `scope` (`model`/`feature`/`shared`), `remaining`, `remainingPercent`, `resetAt` (ms), `windowSeconds`, `observedAt` | Read from the ChatGPT page by the extension (`observeUsage` / `reportedUsageLimits()`); snapshots older than 10 minutes are rejected | **Yes**, reported by ChatGPT, but only as fresh as the last page observation |
| Verified native sends per day, per model family (`gpt-5.6`, `gpt-6`) | Counted from delivered user-message rows with model proof | Yes (counts only) |
| Token totals | `estimatedTokens` and a context-size heuristic (`billingContext / 2`, assumed models for legacy rows) | **No, estimates** |

The controller (`control-api.ts`) exposes no usage route today.

Consequences:

- CoS cannot honestly report per-turn input/output tokens. Under the project rule (unsupported capabilities fail explicitly, nothing is approximated), the tokens/sec readout stays empty for CoS. That is correct, not a gap to close.
- CoS can report subscription limit windows. That maps directly onto T3's `ServerProviderUsageLimits`.

## T3 side (pinned `ffb4af8d`)

- `ServerProvider.usageLimits` is per provider instance, not tied to the closed `UsageProviderKind` enum. It carries `windows` (`id`, `kind`, `label`, `usedPercent`, `resetsAt`, `windowDurationMins`), plus `unavailable: { reason: "unsupported" | "probeFailed" }` and `externalUsage` link states. A generic ACP instance can publish these without a schema change.
- The cost/token tabs of the `/usage` page are transcript-derived and do not apply to CoS.
- The generic ACP adapter did not fill per-turn `TurnTokenUsage`. Patch `0002` (`handoff/t3-patches/`) now maps ACP prompt-response usage into it, which helps any ACP provider that reports tokens. It does not help CoS.

## Proposed contract: `provider-usage-v1`

Controller feature advertised on `/v1/health` as `provider-usage-v1: 1`. Read-only, authenticated, same Host/Origin/rate rules as protocol 1.

```text
GET /v1/usage
→ {
    "observedAt": 1730000000000 | null,
    "limits": [ { "model": "...", "scope": "model"|"feature"|"shared",
                  "remaining": number|null, "remainingPercent": 0..100|null,
                  "resetAt": ms|null, "windowSeconds": number|null } ],
    "messages": { "through": ms, "days": [ { "date": "YYYY-MM-DD", "gpt56": n, "gpt6": n } ] }
  }
```

Rules:

- `limits` is the latest `reportedUsageLimits()` verbatim. An empty array with `observedAt:null` means "not reported yet", which the bridge maps to unavailable, never to 0% used.
- Rows older than the CoS freshness window are not served as current.
- No tokens, no prompt/tool content, no secrets cross this route. Token estimates are deliberately excluded.
- Account-wide, not session-scoped: ChatGPT limits belong to the account, so the route is not keyed by session.

### Bridge mapping

- Poll `/v1/usage` at most once per drained turn plus a low-rate refresh while a thread is open, only when the feature is advertised.
- Convert each row to a T3 window: `usedPercent = 100 - remainingPercent` (skip the row when `remainingPercent` is null), `resetsAt` from `resetAt`, `windowDurationMins = windowSeconds / 60`, `kind` from `windowSeconds` (`604800` is `weekly`, `18000` is `session`, else `other`), `id`/`label` from `scope` + `model`.
- Surface to T3 through a namespaced ACP `_meta` field on the session/prompt response (versioned, e.g. `t3onsteroids/usage-limits@1`). `_meta` is reserved for extension, but T3 must be patched to read it, so this ships only with the T3 patch below.

### T3 patch (third in the series, not yet written)

In the ACP provider, read the namespaced `_meta` and merge it into the instance's `usageLimits` using the existing `ProviderUsageLimitsUpdate` merge-by-`id` path; set `unavailable: { reason: "unsupported" }` when the bridge does not advertise the feature. The existing Limits tab then renders CoS with no page changes.

## Work remaining, in order

1. CoS patch: add `provider-usage-v1` and the `/v1/usage` route in `control-api.ts` (new patch `0018` in `handoff/cos-provider-extension-patches`), with tests and `CONTROL_API_ROUTES` / health feature registration.
2. Bridge: typed client method, feature gate, freshness handling, the mapping above, and a requalification entry (new live evidence, since the tuple changes).
3. T3 patch 3 (above), then a sandboxed browser check of the Limits tab using a mock ACP agent.

## Open questions

- Exact `windowSeconds` values ChatGPT reports for its session-style windows (verify against a live observation before hard-coding the `kind` mapping).
- Whether to expose message counts to T3 at all (no existing T3 surface for them); default is to keep the route field for future use and omit it from the T3 mapping.
