Evidence-Schema: 1
Gate: performance
Status: PENDING

# V1 Step 7 — live single-turn performance qualification

`bridgeImplementationCommit`: `69f00277698e6e1fc36914c4fa8992b5f79ebbc5`.

`evidenceCommit`: `69f00277698e6e1fc36914c4fa8992b5f79ebbc5` (implementation commit used as the current evidence-refresh base; historical live artifacts retain their own evidence commits).

**Historical result only — invalidated.** The measurements below were recorded against prior implementation commit `336c701c7fb3da967ef11c6b167da8a266becc46`. Exact-Stop and recovery behavior changed after that run, and the current implementation identity is now `69f00277698e6e1fc36914c4fa8992b5f79ebbc5`. Under `PLAN.md`'s implementation-input invalidation rule, the old PASS does not satisfy the current Step-7 gate. Keep the raw measurements as history, but rerun the current implementation tuple before restoring `Status: PASS`.

Target pinned runtime tuple for the rerun: T3 `0.0.46-nightly.20261013.3040` / `ffb4af8d5d4fcfc5e9322295ff846a6d1e7ffbf8`; CoS base `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`; CoS `providerExtension` buildId `76fe2e7f3236e2ae2ffd4ec4606759909257fd69`; ACP SDK `1.9.0`; Node `24.21.0`; Windows x64. The historical turns below were exercised through the Chat On Steroids browser conversation named `T3 Code`, not by sending test prompts through the desktop app UI. Their raw artifacts remain preserved under the old tuple and do not count for the current gate.

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

Current implementation validation at `69f00277698e6e1fc36914c4fa8992b5f79ebbc5`: clean `npm ci` PASS; `npm run verify` PASS — 25/25 test files, 243/243 tests, including typecheck, lint, build and package smoke; `npm audit --json` exits 0 with zero vulnerabilities; `git diff --check` PASS. Final provider-source verification at `76fe2e7f3236e2ae2ffd4ec4606759909257fd69` also exits 0. This is deterministic source/build evidence only and does not refresh the older live measurements. The running pinned CoS candidate must still be safely reconciled from its currently installed provider identity to the final provider build, and its staged `2.1.44` updater hazard must be neutralized or isolated before any restart can count. The combined evaluator output remains historical; Step 7 stays pending until a fresh live run is safe. The pinned V1-01…V1-19 acceptance matrix and Step-9 current-T3-HEAD drift/release preparation remain separate gates; overall release qualification remains false.
