Evidence-Schema: 1
Gate: cosProviderExtension
Status: PASS

# V1 Step 1 — CoS provider extension

`bridgeImplementationCommit`: `32db15baa1961e6fd1e16135ed18ee6e59b322f8`.

Pinned CoS base remains `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`. Final provider-extension source/build identity for this qualification freeze is `9ef2da538654c651dd3853890816f8a21b93fe08`.

The preserved historical source baseline was `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`. The provider lineage includes the restart-unsealed recovery work, then `72c24f4e41877f2536cc7bfcc5f60a7eba0759a6` (`Do not treat request attribution as provider effects`) and `9ef2da538654c651dd3853890816f8a21b93fe08` (`Serialize process-sensitive verification suites`). The V1-11 RCA established that a bare Fiber `metadata.request_id` in `requests[]` is correlation/attribution data rather than exact-turn native-effect proof; the corrected predicate therefore omits bare `requests[]` while continuing to block recovery on real effect surfaces (`calls`, `codeModeCalls`, `sightings`, `activities`, and trace `call`/`exec`). Generic `broken` state remains fail-closed, and the recovery path still requires the exact persisted restart-unsealed shape, matching terminal/token identity, no conflicting terminal, fresh browser proof, and normal drain finalization. It does not synthesize `turn_end` or `turn_drained`, infer no-effects from `toolCalls:0`, or rewrite preserved session state.

The final provider extension advertises API version `1` and all five required feature ids at version `1`:

- `provider-project-resolve-v1`: `1`
- `provider-assistant-content-v1`: `1`
- `provider-session-policy-v1`: `1`
- `provider-turn-drain-v1`: `1`
- `provider-turn-recovery-v1`: `1`

Final source verification on `9ef2da538654c651dd3853890816f8a21b93fe08`:

```text
npm run verify                              PASS — exit 0
bulk Vitest lane                            PASS — 351 files passed, 5 skipped; 6621 tests passed, 46 skipped
serialized heavy lane                       PASS — 14 files, 2454 tests passed; 4 skipped tests
isolated renderer-state lane                PASS — 1 file, 132 tests
explicit typecheck / git diff --check       PASS — exit 0 / exit 0
provider npm audit --json                   PRESERVED — 19 advisories: 11 moderate, 8 high, 0 critical
```

Recovery-focused qualification is green: an explicit combined serialized run of `provider-turn-drain.test.ts`, `bridge.test.ts`, `content-script.test.ts`, and `extension.test.ts` passes `1994/1994` across four files (`12/12`, `697/697`, `936/936`, and `349/349`). The final isolated `renderer-state.test.ts` passes `132/132`. The runner-only `9ef2da53` commit serializes three known process-sensitive suites; it changes no production semantics or acceptance assertions. The uninterrupted final verification completed cleanly.

Browser-extension file identity is separate from the provider-extension build id. The previously running `4a32b824` portable candidate had browser-extension stamp `ecc2a76d317a` and EXE SHA-256 `E4A209847EBB00991B4B81C814F331BC78432910C3DFEF9E2FE464704C20CB8A`; those values are historical and are not evidence for the `9ef2da53` freeze. Packaging and live provenance for the corrected provider are a downstream action after this source gate: `npm run dist:x64` must run from the clean exact `9ef2da53` checkout, the new extension stamp and portable EXE hash must be computed rather than guessed, and the generated NSIS installer must not be run.

The final provider dependency audit remains nonzero and is preserved as such: `19` total advisories (`8` high, `11` moderate, `0` critical). This evidence does not convert that result into a zero-vulnerability claim.

This gate is source/provider-extension qualification only. The corrected `9ef2da53` portable candidate has not yet been promoted into the preserved V1 profile, and the preserved V1-11 turn has not yet been authoritatively reconciled. Packaging/live identity, preserved V1-11 recovery, Step-7 performance, and Step-8 acceptance therefore remain pending. Overall `releaseQualified` remains false.
