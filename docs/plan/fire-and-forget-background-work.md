# Fire-and-forget background work (provider-background-work-v2)

Status: planned, not implemented. Owner decision taken 2026-10-30: **a T3 turn ends when the
provider turn drains, even if native background work is still running; the result of that work is
reported to the same thread afterwards as a follow-up.**

This document is the implementation plan. It states the contract, the data model, every code site
that must change, the tests that prove each layer, and the qualification rows. It also names the one
T3-side change the design needs and the fallback if that patch is not accepted upstream.

---

## 0. Why this needs a contract rather than a flag

Today the bridge sends `providerPolicy: { backgroundWork: "disabled" }` on the first prompt of every
provider session (`src/policy/index.ts`, sent at `src/acp/index.ts:1622`). CoS must attest
`{ backgroundWork: "disabled", enforced: true }`, and the bridge refuses the session otherwise
(`provider_policy_unavailable`).

That literal is load-bearing in two different senses and the code currently conflates them:

1. **Identity** — "this session is a provider session under the v1 fence".
2. **Prohibition** — "this session may not produce background work".

CoS checks the literal at 13 sites in `src/main/session/store.ts` (lines 345, 462, 524, 533, 664,
698, 732, 797, 812, 829, 847, 889 and the projection in `control-reads.ts`), in the action gate
(`control-api.ts:399-408`), and in the input schema (`session/input.ts:45`,
`z.literal('disabled')`). Enabling background work therefore means auditing each site and deciding
which sense it means, not flipping a value.

The bridge side has the mirror problem: one turn is the unit of work — one active input, one lease,
release at authoritative drain, and `assertBackgroundWorkSettled` failing the turn with
`turn_drain_pending` when a projection reports pending work (`src/acp/index.ts:350-353`).

---

## 1. Semantics

**Turn.** A turn is the interval between `session/prompt` and its `end_turn`. It ends when CoS
publishes the authoritative drain for that input, regardless of background work.

**Follow-up.** Work that a turn started and that outlives it: a worker, a Goal/Loop continuation, or
any future work item the projection reports. A follow-up is *owned* by the input that started it and
*belongs* to the ACP session's thread.

**Delivery.** When a follow-up reaches a terminal state, the bridge reports it to T3 out of turn:

- a T3-visible notification naming the work item and its outcome, and
- the follow-up's own text (assistant message or worker report) as the thread's next agent output.

Nothing about the turn's own `end_turn` changes: a user who never looks at the follow-up still sees
a completed turn.

**Cancellation.** `session/cancel` cancels work *while the turn is running*. After `end_turn`, work
continues; the user cancels it through the existing per-work route, which the bridge exposes as a
tool-less action (`POST /v1/sessions/{id}/background-work/{workId}/cancel`).

**Failure.** A follow-up that fails is reported as a failed follow-up, not as a broken session. A
follow-up that can never be delivered (session closed, thread deleted) is retired with a recorded
reason; it never resurrects a closed turn.

---

## 2. Contracts

### 2.1 Provider feature and policy value

- New feature flag in `/v1/health`: `provider-background-work-v2: 1`.
- New policy value: `providerPolicy.backgroundWork: "reported"` (v1 value `"disabled"` unchanged).
  `"reported"` means: background work is allowed; its results are published as follow-ups.
- Attestation: sessions created with `"reported"` attest `{ backgroundWork: "reported",
  enforced: true }`. The bridge refuses a mismatch exactly as today.
- The bridge asks for `"reported"` only when the feature is advertised **and** the bridge's own
  follow-up queue is compiled in (`compatibility.cos.providerExtension.features` gains the flag).
  Absent the feature, the bridge keeps sending `"disabled"` and behaviour is byte-identical to today.

### 2.2 Projection

`GET /v1/sessions/{id}/background-work` keeps its shape and adds fields:

```jsonc
{
  "state": "none" | "pending" | "disabled" | "violated",
  "pending": [
    { "id": "worker:…" | "goal:…", "label": "…", "state": "…",
      "ownerInputId": "…",           // new: the turn that started it
      "terminal": false,             // new
      "outcome": null                // new: "completed" | "failed" | "cancelled" when terminal
    }
  ]
}
```

`violated` disappears under v2 (it is a v1-only verdict). The bridge treats `state` as advisory and
reads `pending` exactly.

### 2.3 Late completion events

A follow-up that produces provider-visible content after the drain publishes it on the existing
session event stream with:

- `ownerInputId` naming the turn that started the work,
- `late: true` on the event,
- a sequence that continues the session's single monotonic sequence (never a second counter).

The v1 invariant "no provider-visible rows after the drain" becomes "no *turn-owned* rows after the
drain; `late` rows are allowed and are attributed to their `ownerInputId`".

### 2.4 Cancel

`POST /v1/sessions/{id}/background-work/{workId}/cancel` stays as the single route. Under v2 it must
also cancel Goal/Loop continuations; today it answers 409 `unsupported_background_work_kind` for
them. If Goal cannot expose a cancel primitive, the route must say so per item and the projection
must mark that item `cancellable: false` so the bridge never offers an action that cannot work.

### 2.5 Bridge durable state (schema `backgroundFollowUps`)

```ts
type FollowUpState = {
  readonly sessionId: string;
  readonly cursor: number;                        // last session event seq delivered
  readonly items: readonly {
    readonly ownerInputId: string;
    readonly workId: string;
    readonly reportedAt: number | null;           // null = still pending
    readonly deliveredSeq: number | null;         // null = not yet emitted to T3
    readonly outcome: "completed" | "failed" | "cancelled";
  }[];
};
```

Durability rules: written before the notification is emitted, and the cursor advances only after the
ACP write succeeds. A restarted bridge replays undelivered items from the cursor.

---

## 3. Flows

### 3.1 Starting work that outlives the turn

```
T3 --session/prompt--> Bridge --POST /v1/inputs--> CoS
                                   CoS: admit, send, turn active
                                   worker/Goal starts, projection = pending
Bridge: waits for authoritative drain (unchanged)
CoS:  turn_drained
Bridge: projection.pending = [w1] ---- v1: throw turn_drain_pending
                                   \--- v2: persist follow-up w1, release lease
Bridge --end_turn--> T3            (user sees a completed turn)
```

### 3.2 Completion

```
CoS: worker w1 finishes; publishes late event seq N with ownerInputId
Bridge watcher (per open ACP session, SSE from cursor):
  sees terminal w1 -> marks item terminal
  emits session/update out of turn:
     agent_message_chunk: "Background work finished: <label> — completed.\n\n<text>"
  persists deliveredSeq
T3: (with the T3 patch) buffers the post-settle wake and offers a continuation run
    -> session/prompt (continuation)
Bridge: answers that continuation from the durable item (no CoS send),
        marking it delivered; the user sees the follow-up in the thread
```

### 3.3 Restart

```
Bridge restart -> read backgroundFollowUps
  cursor < session head -> replay pending/terminal items, emit what was not delivered
  item delivered but CoS lost the row -> retire the item with reason "provider_row_missing"
CoS restart -> projection re-read; work that died with the app is reported failed, not pending
```

---

## 4. Component changes

### 4.1 CoS (provider)

| File | Change |
| --- | --- |
| `src/main/session/input.ts:45` | `providerPolicy` schema accepts `"disabled" \| "reported"`; keep `.strict()`. |
| `src/main/session/store.ts:345,462,524,533` | Split "is a provider session" from "background work forbidden". Identity checks become `policyIsProvider(policy)`; prohibition checks compare against `"disabled"`. |
| `src/main/session/store.ts:664,698,732,797,812,829,847,889` | Same audit; each site gets a comment naming which sense it means and a test. |
| `src/main/control-api.ts:399-408` | `providerOwnedInput` accepts both policy values; the admission barrier stays keyed on provider ownership, not on the background-work value. |
| `src/main/control-reads.ts` (backgroundWork) | Add `ownerInputId`, `terminal`, `outcome`, `cancellable`; emit `pending` instead of `violated` for `"reported"`. |
| `src/main/session/recorder.ts` (late events) | Record `late` + `ownerInputId` on provider-visible rows published after a drain under `"reported"`; keep the v1 refusal for `"disabled"`. |
| `src/main/control-workers.ts` | Cancel route covers `"reported"` sessions and Goal items where a primitive exists; refuses per item otherwise. |
| `src/main/goal.ts` | Goal/Loop continuations register as follow-ups with `ownerInputId`; if Goal cannot be cancelled, mark `cancellable: false`. |
| `src/main/catalog`/health | Advertise `provider-background-work-v2: 1`. |

### 4.2 Bridge

| File | Change |
| --- | --- |
| `src/policy/index.ts` | `V1_BACKGROUND_WORK_POLICY = "disabled"`, `V2_BACKGROUND_WORK_POLICY = "reported"`, `v2ProviderSessionPolicy`. |
| `src/compatibility.ts` | Add `provider-background-work-v2: 1` to required features; new `buildId`. |
| `src/acp/index.ts:1344-1350` (policy choice) | Choose v2 only when `readiness.features["provider-background-work-v2"] === 1`; otherwise v1. |
| `src/acp/index.ts:350-353` | `assertBackgroundWorkSettled` becomes `settleOrRegisterFollowUps(session, inputId)`: empty projection → unchanged; non-empty under v2 → persist items + release lease + continue; non-empty under v1 → `turn_drain_pending` as today. |
| `src/session/index.ts` (durable state) | Add `backgroundFollowUps` to the session state, schema-versioned, with migration from v1 state (absent = empty). |
| `src/cos/index.ts` | Projection parser reads the new fields (fail closed on unknown shape); event stream exposes `late`/`ownerInputId`. |
| `src/follow-ups/index.ts` (new) | Per-session watcher: subscribe from cursor, classify terminal items, emit out-of-turn `session/update`, persist before/after emit, replay on resume, retire on provider-row-missing. |
| `src/acp/stdio.ts` + session lifecycle | Keep the ACP connection alive after `end_turn` while items are pending; stop the watcher when the last item is retired. Raise the agent's `idle` timeout accordingly. |
| `src/acp/index.ts` (`session/prompt` entry) | If the incoming prompt is T3's continuation and undelivered items exist, answer from the queue without a CoS send. |

### 4.3 T3 (maintained patch, capability-gated)

The ACP adapter already supports post-settle wakes and continuation offers, but only for flavors that
opt in (`packages/provider-acp/src/server/adapter.ts:1368`:
`postSettleContinuationEnabled = flavor.enablePostSettleContinuation === true`). Only the Grok flavor
sets it today (`packages/provider-grok/src/server/adapter.ts:338`).

Patch (three small hunks, shipped as a maintained patch file in `patches/t3/`):

1. `packages/provider-acp-registry/src/server/adapter.ts` — read
   `initialize.agentCapabilities._meta.cosBackgroundWork === true` from the registry handshake and
   set `enablePostSettleContinuation: true` on the flavor for that instance.
2. `packages/provider-acp/src/server/adapter.ts` — no change needed if the above suffices; the
   wake path (`acpPostSettleWakeEvidence`) already accepts out-of-turn `agent_message_chunk` text.
3. `packages/provider-acp-registry/src/server/AcpRegistrySupport.ts` — carry the `_meta` capability
   through instance metadata so the adapter can see it.

The bridge advertises `_meta.cosBackgroundWork: true` in `initialize` only when it has the follow-up
queue compiled in and the controller advertises v2. Without the patch, the wake is not buffered and
the fallback below applies.

**Fallback if the patch is rejected:** deliver queued follow-ups at the next `session/prompt`
(prepend a "while you were away" block, emit it as the turn's leading assistant text, and mark the
items delivered). Fire-and-forget still holds on the CoS side; only the T3-visible latency changes.

---

## 5. Invariants and failure modes

| Invariant | How it is kept |
| --- | --- |
| One turn = one input; a follow-up never reopens it | Follow-ups carry `ownerInputId` but never touch the turn projection. |
| No duplicate delivery after restart | Cursor advanced only after the ACP write; item replay is idempotent by `deliveredSeq`. |
| No lost delivery | Provider rows are authoritative; the projection is re-read on every watcher start. |
| A missing provider row cannot wedge the session | Items are retired with `provider_row_missing` and a logged reason (no prompt text). |
| v1 sessions unchanged | v2 policy is requested only when the feature is advertised; all v1 branches keep their tests. |
| Cancel cannot lie | The projection marks `cancellable: false` when no primitive exists; the route refuses per item. |
| Nothing is logged that should not be | Follow-up labels are bounded metadata; message text is never logged. |

Known failure shapes and their handling:

- **Worker dies with the app.** Projection reports `failed`; the watcher reports a failed follow-up.
- **Bridge restarts mid-turn.** Existing durable recovery owns the turn; the watcher starts from the
  persisted cursor afterwards.
- **T3 restarts.** New ACP session; the bridge re-delivers undelivered items into the resumed session
  (the durable queue is per CoS session, not per ACP connection).
- **Thread deleted.** The bridge retires items with `thread_gone` when the ACP session closes
  permanently.
- **CoS downgraded.** Readiness loses v2 → the bridge stops requesting `"reported"`; existing v2
  sessions keep working because the policy is persisted per session.

---

## 6. Tests

**CoS (vitest)**

- Policy: a session created with `"reported"` attests `"reported"`; a `"disabled"` session still
  refuses background work; unknown values are rejected by the schema.
- Store audit: one test per audited site in §4.1 asserting the identity/prohibition sense.
- Projection: pending worker and pending Goal reply both carry `ownerInputId`; terminal items carry
  `outcome`; `cancellable` is false where no primitive exists.
- Late events: a post-drain assistant row is recorded with `late` + `ownerInputId` under
  `"reported"`, and still refused under `"disabled"`.
- Cancel: worker cancel works under `"reported"`; Goal cancel answers per its primitive.
- Regression: the entire v1 suite (control-api actions/reads, session store, recorder) stays green.

**Bridge (vitest)**

- Policy selection: v1 when the feature is absent (byte-identical prompt body), v2 when present.
- Settlement: pending projection under v2 persists items and returns `end_turn`; under v1 it still
  throws `turn_drain_pending`.
- Watcher: terminal item → one out-of-turn `session/update`; duplicate events → one emit; restart
  mid-flight → replay once; provider row missing → retire.
- Continuation: a T3 continuation prompt with queued items is answered from the queue with no CoS
  send (asserted by a fake controller that fails on `send`).
- Cancel: `session/cancel` while pending cancels via the route and records the outcome.

**T3 patch (vitest in the HEAD checkout)**

- Flavor flag is set only when `_meta.cosBackgroundWork === true`.
- An out-of-turn `agent_message_chunk` produces a buffered wake and a continuation offer.
- Without the flag, behaviour is unchanged (no wake, no continuation).

**Live acceptance (new script `scripts/post-v1-followup-live.mjs`)**

1. Start a turn that leaves a worker pending; assert `end_turn` arrives before the worker finishes.
2. Assert one T3-visible follow-up appears afterwards with the worker's outcome.
3. Kill and restart the bridge between drain and completion; assert exactly one follow-up.
4. Cancel a pending worker; assert `cancelled` is reported once and the route refused nothing.
5. Crash the app with a pending worker; assert a `failed` follow-up, not a stuck pending item.

---

## 7. Qualification and rollout

1. Ship v2 **off by default**: CoS advertises it, the bridge pins it, but the bridge requests
   `"reported"` only behind a bridge flag (`T3ONSTEROIDS_BACKGROUND_WORK=reported`), so the existing
   two-chat tuple cannot change behaviour.
2. Run the eight-case 2-chat matrix with the flag off (must be identical to today's `f9adddd`
   result), then with the flag on (must pass, plus the new follow-up rows).
3. Enable the flag by default only after both passes; record the new tuple in
   `docs/release-status.md` and `docs/evidence/post-v1-concurrency-qualification.md`.
4. Keep `supportedConcurrency = 2`. Follow-ups are not a concurrency feature.

---

## 8. Sequence and estimates

| Phase | Work | Depends on |
| --- | --- | --- |
| 0 | Spike: prove the T3 wake path with a one-line flavor change and a synthetic out-of-turn chunk | T3 HEAD build (exists) |
| 1 | CoS v2: schema, policy audit (13 sites), projection fields, late events, cancel, health flag + tests | — |
| 2 | Bridge: policy choice, settlement split, durable queue, watcher, continuation answer + tests | 1 |
| 3 | T3 patch: capability plumbing, flavor flag, patch file, tests | 0 |
| 4 | Live acceptance script + five scenarios | 2, 3 |
| 5 | Matrix with flag off/on, docs, release record | 4 |

Phase 0 is a day. Phase 1 is the largest single piece because of the 13-site audit. Phase 2 is the
second largest. Phases 3–5 are small but need the live lane.

## 9. Open questions for the owner

1. **Follow-up visibility.** Should a follow-up start a T3 continuation turn (the agent speaks in the
   thread, costs a turn) or only post a notification with the outcome? The plan assumes a
   notification plus the follow-up text delivered through a continuation; notification-only is a
   smaller change.
2. **Goal/Loop cancel.** If Goal cannot expose a cancel primitive, is `cancellable: false` acceptable,
   or should v2 require the primitive before it ships?
3. **T3 patch acceptance.** The patch is capability-gated and inert for every other provider; if it
   is not acceptable, the fallback (deliver at the next prompt) is the plan of record.

---

## Phase 0 spike result (2026-10-30)

**Code-level: confirmed.** The post-settle wake path exists in the pinned HEAD and is gated by
exactly one flavor flag:

- packages/provider-acp/src/server/adapter.ts:1368 �
  postSettleContinuationEnabled = flavor.enablePostSettleContinuation === true && continuationRequests !== undefined.
- Only packages/provider-grok/src/server/adapter.ts:338 sets it today, which is why a local
  cpRegistry provider cannot wake the host.
- cpPostSettleWakeEvidence accepts an out-of-turn gent_message_chunk whose text is non-empty
  and does not look like a monitor event, so the text the bridge intends to send qualifies.
- The registry adapter already forwards continuationRequests when the host provides it
  (packages/provider-acp-registry/src/server/adapter.ts, makeAcpAdapterV2 call), so the patch is
  the flavor flag plus the capability plumbing in �4.3 � no new notification type.

**Live confirmation: blocked by the local HEAD checkout, not by the design.** Attempting the spike
exposed that this checkout's toolchain is damaged: 
ode_modules/vite-plus/bin/vp is missing (only
px is installed), so p pack cannot build the server; a pnpm install retry failed in its
prepare script, after which the prebuilt pps/server/dist/binCli-*.mjs fails to start with a
@cursor/sdk CJS-in-ESM error. The server still listening on 8795 was started before that damage and
therefore predates any spike patch, so it cannot demonstrate the wake either.

Consequence: the live half of Phase 0 needs a fresh T3 HEAD checkout and build (clone + install +
p pack, as done for dd14848 on 2026-10-30). Everything the plan depends on is already answered
by the code above; the live run only proves the end-to-end sequencing. No source change was left
behind in the HEAD checkout � the spike patch to
packages/provider-acp-registry/src/server/adapter.ts and the patched dist bundle were both
reverted.
