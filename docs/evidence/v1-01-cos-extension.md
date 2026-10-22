Evidence-Schema: 1
Gate: cosProviderExtension
Status: PASS

# V1 Step 1 — CoS provider extension

`bridgeImplementationCommit`: `69f00277698e6e1fc36914c4fa8992b5f79ebbc5`.

Pinned CoS base remains `2.1.39` / `87ae9d631f82d8da2f462d910410031ad8f97ac5`. Final provider-extension source/build identity for V1 is `76fe2e7f3236e2ae2ffd4ec4606759909257fd69`.

The preserved historical source baseline was `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`, which contained the earlier provider drain/project/terminal-transport repairs. The current lineage adds the production exact-Stop-after-restart repair at `61d111f6940b74e5134986a12b53e7ef1f216328`, followed only by verification/test-isolation hardening through `c80222e4`, `e27c7511`, `654827ba`, `a6e4cf19`, `7772c7b0`, `f5287df9`, and final `76fe2e7f`. Those later commits do not relax exact-turn, Stop, deadline, question-anchor, background-work, terminal, or drain authority.

The final provider extension advertises API version `1` and all four required feature ids at version `1`:

- `provider-project-resolve-v1`: `1`
- `provider-assistant-content-v1`: `1`
- `provider-session-policy-v1`: `1`
- `provider-turn-drain-v1`: `1`

Final source verification on `76fe2e7f3236e2ae2ffd4ec4606759909257fd69`:

```text
npm run verify                              PASS — exit 0
bulk Vitest lane                            PASS — 354 files, 6634 tests; 46 skipped tests
serialized heavy lane                       PASS — 11 files, 2423 tests; 4 skipped tests
isolated renderer-state lane                PASS — 1 file, 132 tests
typecheck / privacy / notices prechecks     PASS as part of npm run verify
```

The recurring `gpt-5.6-pro` automatic-Continue boundary and the native-work Stop-revocation case both pass in the final `input-delivery-integration.test.ts` run (`290/290`). `content-script.test.ts` passes `926/926`, `bridge.test.ts` passes `694/694`, `public-history-privacy.test.ts` passes `23/23`, `worktrees-manager.test.ts` passes `41/41`, and `renderer-state.test.ts` passes `132/132` in its isolated verification lane. The failures that motivated the runner changes were classified as cross-suite load/timing or fixture isolation issues; no acceptance assertion was weakened.

Browser-extension file identity is separate from the provider-extension build id. The currently running pinned `2.1.39` live candidate was previously proven to materialize browser-extension stamp `45ee28157713` from the packaged `73e52028` candidate. That live observation does **not** claim that provider build `76fe2e7f` is already installed in the running app. Live preflight must reconcile the running candidate to the final provider identity before Step 7/8 can pass.

The CoS dependency audit was not rerun as part of this provider-source requalification. The prior non-zero CoS audit disposition remains a release item and is not converted into a zero-vulnerability claim by this evidence.

This gate is source/provider-extension qualification only. It does not claim live installation, browser pairing, candidate replacement, Step-7 performance, or Step-8 acceptance. Overall `releaseQualified` remains false.
