Evidence-Schema: 1
Gate: liveAcceptance
Status: PASS

# V1 Step 8 — pinned acceptance matrix

`bridgeImplementationCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b`.

Pinned release tuple: T3 `0.0.46-nightly.20261013.3040`; CoS `2.1.39`; provider build `495e3e96504d9b865c18478f7b42915280712f84`; candidate SHA-256 `D2A99BC116FEAFE66318AA3912042ED52610EEDAA3569E5C5FFC364FB6307034`; browser-extension stamp `6c66160b96d3`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64.

**Current result: PASS.** The strict PLAN reset after the final bridge/provider changes has been reconciled. Consolidated machine-readable evidence is `.local-evidence/v1/step8-matrix-current.json`; the final live bundle is `.local-evidence/v1/20261023T080342Z-step8-live-final495/step8-matrix.json`. All referenced evidence paths exist and every required row is PASS in its PLAN-owned execution mode.

| Row | Owner/mode | Current-final evidence |
| --- | --- | --- |
| V1-01 | Browser-live | `.local-evidence/v1/20261023T052500Z-v1-01-final/v1-01-attempt-02-pass.json` |
| V1-02 | Browser-live | `20261023T080342Z-step8-live-final495/v1-02-03.json` |
| V1-03 | Browser-live | `20261023T080342Z-step8-live-final495/v1-02-03.json` |
| V1-04 | Browser-live + controller full-content | `20261023T080342Z-step8-live-final495/v1-04.json` |
| V1-05 | Browser-live safe fixture | `20261023T080342Z-step8-live-final495/v1-05.json` |
| V1-06 | Deterministic production path | `20261023T054205Z-step8-deterministic-final/step8-deterministic.json` |
| V1-07 | Deterministic production path | `20261023T054205Z-step8-deterministic-final/step8-deterministic.json` |
| V1-08 | Browser-live Stop | `20261023T080342Z-step8-live-final495/v1-08.json` |
| V1-09 | Deterministic + live SSE smoke | deterministic final + `20261023T054747Z-step7-sse-final495/sse-reconnect.json` |
| V1-10 | Deterministic + live bridge restart | deterministic final + `20261023T054814Z-step7-bridge-restart-final495/restart-smoke.json` |
| V1-11 | Browser-live provider restart/token rotation | `20261023T054001Z-v1-11-final495/v1-11-qualification.json` |
| V1-12 | Mixed: live healthy T3 resume + deterministic negatives | `20261023T080342Z-step8-live-final495/v1-12.json` + deterministic final |
| V1-13 | Browser-live compact/resume/handoff | `20261023T020743Z-v1-13-live/v1-13-attempt-02-pass.json` |
| V1-14 | Browser-live actions disabled/restored | `20261023T045943Z-v1-14-actions-pair/v1-14-pass.json` |
| V1-15 | Browser-live exact-root failure | `20261023T045558Z-v1-15-project-unmapped/v1-15-live-pass.json` |
| V1-16 | Deterministic error policy | deterministic final |
| V1-17 | Browser-live policy/compaction + source tests | `20261023T051800Z-v1-17-policy/v1-17.json` |
| V1-18 | Deterministic + live slow consumer | deterministic final + `20261023T054855Z-step7-slow-final495/slow-consumer.json` |
| V1-19A | Deterministic late-activity/drain ordering | deterministic final |
| V1-19B | Provider source/live drain boundary | `20261023T052300Z-v1-19b-final/v1-19b.json` |

The newly rerun browser-live rows are controller-correlated to the exact isolated 495e candidate, not accepted from UI output alone. V1-12 restarted pinned T3 server PID `21120 -> 34368` and resumed the same T3 thread, CoS session `b162026d-6032-49e1-ba2f-e17eb07f6192`, conversation `6adb1027-7e98-83e8-bf17-6ac571f364c6`, canonical project root, and policy, with exactly one new input and matching final/drain.

Failed, excluded, and setup-invalid attempts remain preserved. In particular: the historical V1-11 admission domain remains fail-closed and untouched; V1-05 retains its zero-tool stopped attempt and `PROVIDER_CALLER_IDENTITY_REQUIRED` attempt; the qualifying V1-05 row is the separate one-edit `apply_patch` + `read` turn; `STEP7-495-N02-84B6D2` remains excluded for tool activity; and the UI-only wrong-provider `STEP7-495-N08-8E4F21` remains setup-invalid.

Step 8 is PASS. Step 9 current-T3 drift and release preparation remain separate gates.
