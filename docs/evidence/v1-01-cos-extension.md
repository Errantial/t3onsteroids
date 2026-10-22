Evidence-Schema: 1
Gate: cosProviderExtension
Status: PASS

# V1 Step 1 — CoS provider extension

`bridgeImplementationCommit`: `3d2d224f784620d511f5ba51c23e57198440cb91`.

Pinned CoS base remains `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`. Final provider-extension source/build identity for this qualification freeze is `0e755281cae0f87084293e4a735cc27744691a64`.

The preserved historical source baseline was `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`. The qualified lineage includes `72c24f4e41877f2536cc7bfcc5f60a7eba0759a6` (`Do not treat request attribution as provider effects`), `f418b634` (`Keep restart recovery through history hydration`), runner-only `2d4cf84c8d665e767d5caa1a360ade8880567d61`, and final recovery build `0e755281cae0f87084293e4a735cc27744691a64`. The V1-11 RCA established that a bare Fiber `metadata.request_id` in `requests[]` is correlation/attribution data rather than exact-turn native-effect proof; the corrected predicate therefore omits bare `requests[]` while continuing to block recovery on real effect surfaces (`calls`, `codeModeCalls`, `sightings`, `activities`, and trace `call`/`exec`). The final recovery change keeps those effect blockers and generic `broken` fail-closed semantics while covering the intended retryable post-probe recovery states only when the persisted turn/terminal/token identity, lack of conflicting terminal, and fresh browser proof still agree. It does not synthesize `turn_end` or `turn_drained`, infer no-effects from `toolCalls:0`, or rewrite preserved session state.

The final provider extension advertises API version `1` and all five required feature ids at version `1`:

- `provider-project-resolve-v1`: `1`
- `provider-assistant-content-v1`: `1`
- `provider-session-policy-v1`: `1`
- `provider-turn-drain-v1`: `1`
- `provider-turn-recovery-v1`: `1`

Final source verification on `0e755281cae0f87084293e4a735cc27744691a64`:

```text
npm run verify                              PASS — exit 0
bulk Vitest lane                            PASS — 350 files passed, 5 skipped; 6607 tests passed, 45 skipped
serialized heavy lane                       PASS — 15 files, 2472 tests passed; 5 skipped tests
isolated renderer-state lane                PASS — 1 file, 132 tests
explicit typecheck / git diff --check       PASS — exit 0 / exit 0
provider npm audit --json                   PRESERVED — 20 advisories: 12 moderate, 8 high, 0 critical
```

Recovery-focused qualification is green: an explicit combined serialized run of `provider-turn-drain.test.ts`, `bridge.test.ts`, `content-script.test.ts`, and `extension.test.ts` passes `1998/1998` across four files. The final isolated `renderer-state.test.ts` passes `132/132`. The final `0e755281` recovery build preserves exact-turn effect blockers and generic `broken` fail-closed behavior while covering the retryable probe states needed by the restart-unsealed recovery path. The authoritative full verify, standalone typecheck, and `git diff --check` all completed cleanly.

Browser-extension file identity is separate from the provider-extension build id. The previously running `4a32b824` portable candidate had browser-extension stamp `ecc2a76d317a` and EXE SHA-256 `E4A209847EBB00991B4B81C814F331BC78432910C3DFEF9E2FE464704C20CB8A`; those values are historical and are not evidence for the `0e755281` freeze. Packaging and live provenance for the final provider are a downstream action after this source gate: `npm run dist:x64` must run from the clean exact `0e755281cae0f87084293e4a735cc27744691a64` checkout, the new extension stamp and portable EXE hash must be computed rather than guessed, and the generated NSIS installer must not be run.

The final provider dependency audit remains nonzero and is preserved as such: `20` total advisories (`8` high, `12` moderate, `0` critical). The untouched `2d4cf84c` checkout now reports the same `20` advisories on its unchanged lockfile/Electron `44.3.0`; the increase from the previously recorded `19` is advisory-database drift from a newly published Electron advisory, not a dependency change in `0e755281`. The PLAN permits documented residuals, so no audit fix is folded into this provider qualification and this evidence does not convert the result into a zero-vulnerability claim.

This gate is source/provider-extension qualification only. The final `0e755281` source build has not yet been proven by a new packaged/live candidate in the preserved V1 profile, and the preserved V1-11 turn has not been authoritatively proven recovered. Packaging/live identity, preserved V1-11 recovery, Step-7 performance, and Step-8 acceptance therefore remain pending. Overall `releaseQualified` remains false.
