Evidence-Schema: 1
Gate: cosProviderExtension
Status: PASS

# V1 Step 1 — CoS provider extension

`bridgeImplementationCommit`: `f3a672cffdee77f54d377d5594893e0606d20d5b`.

Pinned CoS base remains `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`. Final provider-extension source/build identity for this qualification freeze is `495e3e96504d9b865c18478f7b42915280712f84`.

## Current-final refresh — 2026-10-23

Strict-reset reconciliation is current on bridge `f3a672cffdee77f54d377d5594893e0606d20d5b` and provider build `495e3e96504d9b865c18478f7b42915280712f84` with pinned T3 `0.0.46-nightly.20261013.3040`. Exact live provider provenance is `.local-evidence/v1/20261023T052300Z-v1-19b-final/v1-19b.json`: CoS `2.1.39`, candidate SHA-256 `D2A99BC116FEAFE66318AA3912042ED52610EEDAA3569E5C5FFC364FB6307034`, all five required provider features, and same-build live drain. Historical provider-build references later in this file are retained for lineage only and are not the current release tuple.

The preserved historical source baseline was `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`. The qualified lineage includes `72c24f4e41877f2536cc7bfcc5f60a7eba0759a6` (`Do not treat request attribution as provider effects`), `f418b634` (`Keep restart recovery through history hydration`), runner-only `2d4cf84c8d665e767d5caa1a360ade8880567d61`, recovery build `0e755281cae0f87084293e4a735cc27744691a64`, and final provider build `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f` (`Ignore representation-only replays after provider drain`). The final source delta after `0e755281` is limited to `src/main/session/store.ts` plus `test/provider-turn-drain.test.ts`: after authoritative provider drain, representation-only replay records are ignored rather than re-opening provider-turn semantics. The existing exact-turn effect blockers and generic `broken` fail-closed semantics remain intact. The recovery path still requires matching persisted turn/terminal/token identity, no conflicting terminal, and fresh browser proof; it does not synthesize `turn_end` or `turn_drained`, infer no-effects from `toolCalls:0`, or rewrite preserved session state.

The final provider extension advertises API version `1` and all five required feature ids at version `1`:

- `provider-project-resolve-v1`: `1`
- `provider-assistant-content-v1`: `1`
- `provider-session-policy-v1`: `1`
- `provider-turn-drain-v1`: `1`
- `provider-turn-recovery-v1`: `1`

Final source verification on `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f`:

```text
npm run verify                              PASS — exit 0
bulk Vitest lane                            PASS — 350 files passed, 5 skipped; 6608 tests passed, 45 skipped
serialized heavy lane                       PASS — 15 files, 2472 tests passed; 5 skipped tests
isolated renderer-state lane                PASS — 1 file, 132 tests
focused provider-turn-drain lane            PASS — 1 file, 13/13 tests
explicit typecheck / git diff --check       PASS — exit 0 / exit 0
provider npm audit --json                   PRESERVED — 12 advisories: 4 moderate, 8 high, 0 critical
```

Recovery-focused qualification is green: the focused final `provider-turn-drain.test.ts` run passes `13/13`, and the isolated `renderer-state.test.ts` passes `132/132`. The final `e5157983` provider change ignores representation-only replay records after authoritative provider drain without changing exact-turn effect blockers, retryable recovery constraints, or generic `broken` fail-closed behavior. The authoritative full verify, standalone typecheck, and `git diff --check` all completed cleanly.

Browser-extension file identity is separate from the provider-extension build id. The previously running `4a32b824` portable candidate had browser-extension stamp `ecc2a76d317a` and EXE SHA-256 `E4A209847EBB00991B4B81C814F331BC78432910C3DFEF9E2FE464704C20CB8A`; those values are historical and are not evidence for the `e5157983` freeze. Packaging and live provenance for the final provider are a downstream action after this source gate: `npm run dist:x64` must run from the clean exact `e5157983c6b5cbc7a9a1fc77c0822d452ab52d2f` checkout, the new extension stamp and portable EXE hash must be computed rather than guessed, and the generated NSIS installer must not be run.

The final provider dependency audit remains nonzero and is preserved as such: `12` total advisories (`8` high, `4` moderate, `0` critical). The untouched `2d4cf84c` checkout currently reports the same `12` advisories on its unchanged lockfile, so this count is advisory-database drift rather than a dependency change introduced by `e5157983`. The PLAN permits documented residuals, so no audit fix is folded into this provider qualification and this evidence does not convert the result into a zero-vulnerability claim.

This gate is source/provider-extension qualification only. The final `e5157983` source build has not yet been proven by a new packaged/live candidate in the preserved V1 profile, and the preserved V1-11 turn has not been authoritatively proven recovered. Packaging/live identity, preserved V1-11 recovery, Step-7 performance, and Step-8 acceptance therefore remain pending. Overall `releaseQualified` remains false.
