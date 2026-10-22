Evidence-Schema: 1
Gate: cosProviderExtension
Status: PASS

# V1 Step 1 — CoS provider extension

`bridgeImplementationCommit`: `b4fb45d5b1ae6683d2b42e71589e207ff2f662dd`.

Pinned CoS base remains `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`. Final provider-extension source/build identity for V1 is `4a32b82499af82948580235b3d1c66f2e84ad762`.

The preserved historical source baseline was `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`. The previously qualified provider `76fe2e7f3236e2ae2ffd4ec4606759909257fd69` added the exact-Stop-after-restart and verification-isolation work. The final lineage then adds `e8ef46d8` (`Recover restart-unsealed provider drains`) and `4a32b824` (`Stabilize UIA invoke observation`). The recovery change is deliberately narrower than generic broken-state recovery: it requires the exact persisted restart-unsealed shape, matching terminal and token identity, no conflicting terminal, no durable exact-turn provider effect, fresh browser proof of zero native effect surfaces, and normal drain finalization. It does not synthesize `turn_drained` or reinterpret arbitrary `broken` state as recoverable.

The final provider extension advertises API version `1` and all five required feature ids at version `1`:

- `provider-project-resolve-v1`: `1`
- `provider-assistant-content-v1`: `1`
- `provider-session-policy-v1`: `1`
- `provider-turn-drain-v1`: `1`
- `provider-turn-recovery-v1`: `1`

Final source verification on `4a32b82499af82948580235b3d1c66f2e84ad762`:

```text
npm run verify                              PASS — exit 0
bulk Vitest lane                            PASS — 354 files, 6639 tests; 46 skipped tests
serialized heavy lane                       PASS — 11 files, 2436 tests; 4 skipped tests
isolated renderer-state lane                PASS — 1 file, 132 tests
typecheck / privacy / notices prechecks     PASS as part of npm run verify
```

Recovery-focused qualification is green: `provider-turn-drain.test.ts` passes `12/12`, `extension.test.ts` passes `349/349`, `bridge.test.ts` passes `697/697`, and `content-script.test.ts` passes `936/936`. The final isolated `renderer-state.test.ts` passes `132/132`. During one duplicate concurrent full verification a Windows/Electron fixture timed out at 35 seconds while another full verification was already running; the same `codex-plugin-runtime-process.test.ts` then passed `5/5` in isolation, including the timed-out production-launch case in 845 ms. The uninterrupted final verification completed cleanly; no acceptance assertion or timeout was weakened.

Browser-extension file identity is separate from the provider-extension build id. The final packaged browser-extension stamp is `ecc2a76d317a`, computed over 31 loaded extension files. The packaged `win-unpacked\Chat On Steroids.exe` has ProductVersion `2.1.39.0` and SHA-256 `E4A209847EBB00991B4B81C814F331BC78432910C3DFEF9E2FE464704C20CB8A`. Read-only ASAR inspection confirms the bundled main process contains exact provider build id `4a32b82499af82948580235b3d1c66f2e84ad762` and the `provider-turn-recovery-v1` capability. Packaging smoke reports the win32-x64 resources/native runtimes verified for `2.1.39`. The NSIS artifact was built as part of `dist:x64` but was not run and is not an accepted installation path for this qualification.

The final provider dependency audit remains nonzero and is preserved as such: `19` total advisories (`8` high, `11` moderate, `0` critical). This evidence does not convert that result into a zero-vulnerability claim.

This gate is source/provider-extension qualification only. The final portable candidate has been built and provenance-checked, but the preserved V1 profile has not yet been replaced/restarted onto it in this qualification sequence. It therefore does not claim live installation, browser pairing, preserved V1-11 recovery, Step-7 performance, or Step-8 acceptance. Overall `releaseQualified` remains false.
