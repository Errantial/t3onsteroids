# Maintained T3 patch: post-settle background work

`post-settle-background-work.patch` applies to upstream `dd148481531a0a090780a2ade20588566db099a2`
(the pinned T3 HEAD this lane accepts against) and is the only T3-side change the fire-and-forget
background-work contract needs.

## What it does

An ACP agent may advertise, on its `initialize` handshake:

```json
{ "agentCapabilities": { "_meta": { "cosBackgroundWork": true } } }
```

When it does, the host accepts the agent's out-of-turn `session/update` notifications after a turn
has settled, buffers them as a wake, and offers a continuation run. When it does not, behaviour is
exactly upstream: nothing an agent says after its turn can wake the host.

## The three hunks

1. `packages/provider-acp/src/server/adapter.ts` — `acpAdvertisesBackgroundWork()` reads the
   advertised capability; a per-session `postSettleCapable` Ref carries it, and
   `bufferPostSettleWake` requires it in addition to the existing flavor flag.
2. Same file — no change to the wake evidence rules: a non-empty `agent_message_chunk`,
   `user_message_chunk` or background tool update is accepted exactly as for the Grok flavor today.
3. `packages/provider-acp-registry/src/server/adapter.ts` — the registry flavor declares
   `enablePostSettleContinuation: true`. That flag was already the coarse gate (only Grok set it);
   the handshake capability decides whether it takes effect, so every other registry agent is
   unaffected.

## Verification

- Built HEAD checkout: `pnpm install --frozen-lockfile`, then `pnpm run build:bundle` in
  `apps/server` (the workspace-level `build` script is broken in this environment).
- With a fake local agent advertising the capability, answering one prompt with `end_turn`, then
  emitting an out-of-turn `agent_message_chunk`: the host logged
  `orchestration-v2.acp-wake-turn-detected` and created a continuation run (`ordinal:2`).
- Without the capability the agent's post-settle chunk is ignored, as upstream does today.
- Known host behaviour in the headless CLI lane: the continuation run is created but not dispatched
  to the agent, which is why the bridge also keeps the follow-up text in its durable queue and
  delivers it at the next user prompt when no continuation prompt arrives.
