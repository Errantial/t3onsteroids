Evidence-Schema: 1
Gate: cosProviderExtension
Status: PASS

# V1 Step 1 — CoS provider extension

`bridgeImplementationCommit`: `a4262c02ad5ffc828d05f12d3f6337c842ddf595`.

Pinned CoS base remains `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`. Final provider-extension source/build identity for this qualification freeze is `2d4cf84c8d665e767d5caa1a360ade8880567d61`.

The preserved historical source baseline was `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`. The final lineage includes `72c24f4e41877f2536cc7bfcc5f60a7eba0759a6` (`Do not treat request attribution as provider effects`), `9ef2da538654c651dd3853890816f8a21b93fe08` (process-sensitive verification serialization), `f418b634` (`Keep restart recovery through history hydration`), and final runner-only `2d4cf84c8d665e767d5caa1a360ade8880567d61` (`Serialize code-mode CPU-sensitive verification`). The V1-11 RCA established that a bare Fiber `metadata.request_id` in `requests[]` is correlation/attribution data rather than exact-turn native-effect proof; the corrected predicate therefore omits bare `requests[]` while continuing to block recovery on real effect surfaces (`calls`, `codeModeCalls`, `sightings`, `activities`, and trace `call`/`exec`). Generic `broken` state remains fail-closed, and the recovery path still requires the exact persisted restart-unsealed shape, matching terminal/token identity, no conflicting terminal, fresh browser proof, and normal drain finalization. It does not synthesize `turn_end` or `turn_drained`, infer no-effects from `toolCalls:0`, or rewrite preserved session state.

The final provider extension advertises API version `1` and all five required feature ids at version `1`:

- `provider-project-resolve-v1`: `1`
- `provider-assistant-content-v1`: `1`
- `provider-session-policy-v1`: `1`
- `provider-turn-drain-v1`: `1`
- `provider-turn-recovery-v1`: `1`

Final source verification on `2d4cf84c8d665e767d5caa1a360ade8880567d61`:

```text
npm run verify                              PASS — exit 0
bulk Vitest lane                            PASS — 350 files passed, 5 skipped; 6607 tests passed, 45 skipped
serialized heavy lane                       PASS — 15 files, 2470 tests passed; 5 skipped tests
isolated renderer-state lane                PASS — 1 file, 132 tests
explicit typecheck / git diff --check       PASS — exit 0 / exit 0
provider npm audit --json                   PRESERVED — 19 advisories: 11 moderate, 8 high, 0 critical
```

Recovery-focused qualification is green: an explicit combined serialized run of `provider-turn-drain.test.ts`, `bridge.test.ts`, `content-script.test.ts`, and `extension.test.ts` passes `1996/1996` across four files (`12/12`, `697/697`, `938/938`, and `349/349`). The final isolated `renderer-state.test.ts` passes `132/132`. The final production fix at `f418b634` preserves recovery through transient older-terminal hydration while keeping genuinely newer or ambiguous terminals fail-closed. The final `2d4cf84c` commit changes verification scheduling only; it does not weaken production semantics or assertions. The authoritative retry completed cleanly.

Browser-extension file identity is separate from the provider-extension build id. The previously running `4a32b824` portable candidate had browser-extension stamp `ecc2a76d317a` and EXE SHA-256 `E4A209847EBB00991B4B81C814F331BC78432910C3DFEF9E2FE464704C20CB8A`; those values are historical and are not evidence for the `2d4cf84c` freeze. Packaging and live provenance for the corrected provider are a downstream action after this source gate: `npm run dist:x64` must run from the clean exact `2d4cf84c` checkout, the new extension stamp and portable EXE hash must be computed rather than guessed, and the generated NSIS installer must not be run.

The final provider dependency audit remains nonzero and is preserved as such: `19` total advisories (`8` high, `11` moderate, `0` critical). This evidence does not convert that result into a zero-vulnerability claim.

This gate is source/provider-extension qualification only. The corrected `2d4cf84c` portable candidate has not yet been promoted into the preserved V1 profile, and the preserved V1-11 turn has not yet been authoritatively reconciled. Packaging/live identity, preserved V1-11 recovery, Step-7 performance, and Step-8 acceptance therefore remain pending. Overall `releaseQualified` remains false.
