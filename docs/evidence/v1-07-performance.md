Evidence-Schema: 1
Gate: performance
Status: PENDING

# V1 Step 7 — live single-turn performance qualification

`bridgeImplementationCommit`: `ef2548b817fe9318ac238e84d0ab39fd65258940`.

**Historical result only — invalidated.** The measurements below were recorded against prior implementation commit `336c701c7fb3da967ef11c6b167da8a266becc46`. Exact-Stop recovery changed at `9f6a70c589ac1ac4831ebde4f3f6d45bc493e3be` and was further hardened for in-flight discovery races and stalled response bodies at `ef2548b817fe9318ac238e84d0ab39fd65258940`. Under `PLAN.md`'s implementation-input invalidation rule, the old PASS does not satisfy the current Step-7 gate. Keep the raw measurements as history, but rerun the current implementation tuple before restoring `Status: PASS`.

Pinned runtime tuple: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc` (browser-extension file stamp is tracked separately in Step-1/live-candidate provenance); ACP SDK `1.9.0`; Node `24.21.0`; Windows x64. Live turns were exercised through the Chat On Steroids browser conversation named `T3 Code`, not by sending test prompts through the desktop app UI. The paired controller and bridge instrumentation used the isolated qualification profile and state root for run `20261019T215853Z`.

## Short-turn measurements

Ten direct-CoS turns passed their authoritative-input, exact-final, no-tool, and matching `turn_end` checks. Ten eligible bridged turns additionally passed matching `turn_drained` and high-water validation. The bridged set is the isolated replacement batch: `.local-evidence/v1/20261019T215853Z/evidence/bridged-short-turns-isolated.jsonl`; its full browser event audit is `browser-turn-event-audit-isolated.json`. Earlier attempts that used tools and the initial ten-turn batch are retained separately; the earlier batch included a 280 ms post-drain outlier while the full verification run was active and is not the qualifying sample.

Nearest-rank p95 results for the ten bridged turns:

| Metric | Result | V1 budget | Outcome |
| --- | ---: | ---: | --- |
| Bridge pre-send overhead | 138 ms | ≤ 250 ms | PASS |
| CoS `turn_end` → `turn_drained` | 77 ms | ≤ 1,000 ms | PASS |
| Bridge post-drain settlement | 88 ms | ≤ 250 ms | PASS |

The secondary end-to-end comparison recorded bridged median/p95 `6,421.5 / 13,401 ms` and direct-CoS median/p95 `22,462.5 / 51,118.67 ms`. Direct generation/browser time is variance-sensitive and is not substituted for the bridge-controlled latency budget. Direct paired evidence: `direct-paired-live-retry/direct-paired.json`; the first 120-second watchdog attempt is preserved at `direct-paired-live/attempt-01-failure.json` and was superseded only after its failure was recorded.

## Long-output, reconnect, and restart

- **Long output / slow ACP consumer: PASS.** Exact final assistant content matched the controller full-content source at 23,182 characters. Peak bridge RSS was `98,844,672` bytes, max queue depth `0` with synchronous downstream backpressure, drain latency `922 ms`, controller reads/actions `38 / 2`, and no SSE reconnect was needed. The evaluation checks for final content, provider policy, no tool activity, deadline, RSS, queue bound, reconnect bound and browser health all passed. Evidence: `slow-consumer-live/slow-consumer.json` and `slow-consumer-live/bridge.metrics.json`.
- **Intentional SSE disconnect/reconnect: PASS on the preserved retry.** The stream resumed from the exact saved cursor (`afterSeq=1`, reconnect `from=2`), with one reconnect and one bounded backoff, no duplicate rows, exact final content, no turn-owned tool activity, and healthy browser/bridge state before and after. Evidence: `sse-reconnect-live-retry/sse-reconnect.json`. The first attempt is retained at `sse-reconnect-live/sse-reconnect.json`; its only failed check was an overly broad harness count that treated the extension-owned `Completed direct response without using tools` marker as tool activity. The harness now ignores only that exact extension marker, and a regression test covers the classification.
- **Built bridge process restart/rebind: PASS.** The process restarted with a different PID, reused the same bound session for the second prompt, preserved policy attestation, completed both exact no-tool turns, and passed no-mutation-spin/bounded-recovery checks. Controller reads/actions were `53 / 4`; max queue depth was `0`; RSS high-water was `101,531,648` bytes. Evidence: `bridge-restart-live/restart-smoke.json` plus the before/after bridge metrics.

## Validation and gate boundary

Historical validation from the old measurement run (`336c701c7fb3da967ef11c6b167da8a266becc46`):

```text
npm run verify                              PASS — 25/25 test files, 234/234 tests
npm exec vitest run -- test/cos-provider-extension.test.ts --maxWorkers=1
                                             PASS — 11/11 tests
npm audit --json                            PASS — exit 0; 0 vulnerabilities at every severity
git diff --check                            PASS
Step-7 combined evaluator                   PASS — 10 bridged + 10 direct
```

Current implementation validation at `ef2548b817fe9318ac238e84d0ab39fd65258940`: `npm run verify` PASS — 25/25 test files, 243/243 tests, including typecheck, lint, build and package smoke; `git diff --check` PASS. This is deterministic source/build evidence only and does not refresh the older live measurements. The combined evaluator output remains historical; Step 7 stays pending until a fresh live run is safe. The pinned V1-01…V1-19 acceptance matrix and Step-9 current-T3-HEAD drift/release preparation remain separate gates; overall release qualification remains false.
