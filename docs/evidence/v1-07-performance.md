Evidence-Schema: 1
Gate: performance
Status: PASS

# V1 Step 7 — live performance qualification

`bridgeImplementationCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b`.

Pinned runtime tuple: T3 `0.0.46-nightly.20261013.3040`; CoS `2.1.39`; provider build `495e3e96504d9b865c18478f7b42915280712f84`; packaged candidate SHA-256 `D2A99BC116FEAFE66318AA3912042ED52610EEDAA3569E5C5FFC364FB6307034`; browser-extension stamp `6c66160b96d3`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

The canonical final-tuple result is `.local-evidence/v1/20261023T061919Z-step7-bridged-final495-canonical/step7-performance-result.json` and is PASS with 10 qualifying bridged no-tool turns plus 10 direct turns. Nearest-rank p95 is `187 ms` bridge pre-send, `803 ms` native `turn_end -> turn_drained`, and `118 ms` bridge post-drain, all within the fixed V1 budgets. The canonical bridged run preserved 11 attempts; the tool-using sample `STEP7-495-N02-84B6D2` is excluded rather than counted.

Required support lanes are also current on the same final provider build:

- SSE reconnect: `.local-evidence/v1/20261023T054747Z-step7-sse-final495/sse-reconnect.json` — PASS, exact cursor resume, one reconnect, no duplicate sequence, matching terminal/drain.
- Bridge restart: `.local-evidence/v1/20261023T054814Z-step7-bridge-restart-final495/restart-smoke.json` — PASS, same session across a real bridge-process restart, no mutation spin, bounded recovery.
- Long output / slow consumer: `.local-evidence/v1/20261023T054855Z-step7-slow-final495/slow-consumer.json` — PASS, exact `23,566`-character content, `89,833,472`-byte RSS high-water, queue depth `0`, drain within `363 ms`.

T3 interaction used the Chat On Steroids background browser-control path, not foreground desktop UI. Step 7 is therefore PASS on the final release tuple.
