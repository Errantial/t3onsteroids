Evidence-Schema: 1
Gate: performance
Status: PASS

# V1 Step 7 — live single-turn performance qualification

`bridgeImplementationCommit`: `4cffd484601ae3dabfc2bce066f47cac3fbf8f9a`.

`evidenceCommit`: `7a8c3ad679aa5d667f9307cf09e6086da53cc43e` (evidence-refresh base before the Step-7 promotion commit; evidence-only commits do not change `bridgeImplementationCommit`).

**Current result: PASS.** Fresh live measurements on the final bridge/provider tuple satisfy the fixed Step-7 budgets. The run used pinned T3 `0.0.46-nightly.20261013.3040`, side-by-side CoS `2.1.39`, packaged candidate SHA-256 `ABC8A63C9A7FD0CB92DD1101EF8E87AB5BC194166DA845AB57EB32B6E8C01EA8`, browser-extension stamp `bafcb47f1143`, and provider-extension build `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f`. T3 interaction was performed through the Chat On Steroids background browser-control path.

Pinned runtime tuple: T3 `0.0.46-nightly.20261013.3040`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; provider-extension build `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

## Short-turn measurements

Ten direct-CoS turns passed authoritative-input, exact-final, no-tool, and matching-terminal checks in `.local-evidence/v1/20261022T231053Z-step7-direct/direct-paired.json`. The fresh bridged run is `.local-evidence/v1/20261022T234109Z-step7-bridged/bridged-short-turns.json`: attempts `1–5` and `7–11` are the ten qualifying no-tool samples. Attempt `6` is preserved in the same artifact and excluded because its native stream contained one `page_tool` event; it still had authoritative input and exact final output, but it is not a no-tool sample.

Nearest-rank p95 results for the ten bridged turns:

| Metric | Result | V1 budget | Outcome |
| --- | ---: | ---: | --- |
| Bridge pre-send overhead | 180 ms | ≤ 250 ms | PASS |
| CoS `turn_end` → `turn_drained` | 856 ms | ≤ 1,000 ms | PASS |
| Bridge post-drain settlement | 111 ms | ≤ 250 ms | PASS |

The secondary end-to-end comparison recorded bridged median/p95 `7,312 / 20,273 ms` and direct-CoS median/p95 `15,505.9 / 16,536 ms`. Generation/browser time is variance-sensitive and is not substituted for the fixed bridge-controlled latency budget.

## Long-output, reconnect, and restart

- **Long output / slow ACP consumer: PASS.** Exact authoritative final content matched at `28,006` characters; peak bridge RSS was `111,165,440` bytes, max queue depth `0`, no tool activity occurred, and the bounded drain/reconnect/browser checks all passed. Evidence: `.local-evidence/v1/20261022T231430Z-step7-slow/slow-consumer.json` plus its bridge metrics.
- **Intentional SSE disconnect/reconnect: PASS.** The stream resumed from the exact saved cursor with one reconnect and bounded backoff, no duplicate rows, matching terminal/drain, exact final content, and no tool activity. Evidence: `.local-evidence/v1/20261022T231409Z-step7-sse/sse-reconnect.json`.
- **Built bridge process restart/rebind: PASS.** The bridge process restarted, reused the same bound session, preserved provider policy, completed both exact no-tool turns, and passed no-mutation-spin/bounded-recovery checks. Evidence: `.local-evidence/v1/20261022T231600Z-step7-bridge-restart/restart-smoke.json`.

## Validation and gate boundary

The final provider source at `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f` retains its authoritative full verification: bulk `350` files / `6608` tests passed, serialized heavy lane `15` files / `2472` tests passed, renderer-state `132/132`, focused provider-turn-drain `13/13`, content-script `940/940`, bridge `697/697`, with no provider source changes since that run. The bridge implementation identity remains `4cffd484601ae3dabfc2bce066f47cac3fbf8f9a`.

Step 7 is therefore PASS for the final pinned tuple. The Step-8 V1-01…V1-19 matrix and Step-9 current-T3-HEAD/fresh-checkout/release preparation remain separate release gates, so overall `releaseQualified` remains false.
