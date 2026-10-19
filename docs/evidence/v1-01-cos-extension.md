Evidence-Schema: 1
Gate: cosProviderExtension
Status: PASS

# V1 Step 1 — CoS provider extension

Bridge implementation identity for this qualification tuple: `23d385d0d62dc7fefbbf5dc702f70115af644453`.

Final provider-extension build identity: `0893fbdfe35192f5784f07fc03f97d2ccc235425`, produced from a clean committed CoS tree based on CoS `2.1.39` / upstream source `87ae9d631f82d8da2f462d910410031ad8f97ac5`.

The qualified lineage preserves the exact historical migrated provider-extension implementation at `d5f27e7486c977351401ab1801fb01112aa2919b`, followed by the scoped qualification repairs `eb3ff475` (delivery durability) and `0893fbdf` (fixture-only). The delivery repair preserves frozen `deliveryText` / Goal transport bytes across history publication, restart, and backend changes while retaining terminal-receipt compaction; it does not weaken the original compaction goal. The final `0893fbdf` repair changes qualification fixtures only and does not change production behavior.

The final extension advertises provider-extension API version `1`, clean build id `0893fbdfe35192f5784f07fc03f97d2ccc235425`, and all four required feature ids at version `1`:

- `provider-project-resolve-v1`: `1`
- `provider-assistant-content-v1`: `1`
- `provider-session-policy-v1`: `1`
- `provider-turn-drain-v1`: `1`

Source validation completed for this exact lineage:

- focused provider/controller validation: `11` files / `372` tests PASS;
- full `test/input-delivery-integration.test.ts`: `289/290` PASS, with the only miss being one load-sensitive Pro recovery timing assertion;
- the exact affected six-case Pro recovery family: `6/6` PASS twice on targeted reruns;
- `npm run typecheck`: PASS;
- `npm run build`: PASS.

The isolated input-delivery regression found during qualification was repaired without introducing a product shortcut: exact frozen transport authority remains durable until delivery is terminal, while the intended terminal compaction still occurs. No provider feature was disabled or downgraded, no drain fence was replaced with a timing/silence heuristic, no production assertion was relaxed, and no runtime behavior was weakened to obtain the validation results above. The final fixture repair is test-only.

`FINAL_VERIFY_RESULT: PASS — npm run verify exit 0; main suite 364 passed / 5 skipped test files, 9153 passed / 50 skipped tests; desktop-helper shard 2 files / 28 tests PASS.`

The final quiet-machine `npm run verify` retry completed successfully with exit code `0`, including the main suite totals above and the separate desktop-helper shard at `2` files / `28` tests PASS. Together with the focused provider/controller, input-delivery, typecheck, and build validation above, the Step-1 source gate is PASS for this exact extension build id.

CoS dependency audit disposition is explicitly non-zero and is not represented as a clean audit. Current `npm audit` reports `14` total findings: `6` high, `8` moderate, and `0` critical. High findings include direct `@modelcontextprotocol/client@2.1.0` advisory `GHSA-6qxp-vccf-f47h` (`fixAvailable`), direct `sharp@0.35.4` advisory `GHSA-wq5f-xc86-pv6w` (fixed by `0.35.5`), and `@anthropic-ai/mcpb@2.1.2` through `node-forge@1.4.0` advisory `GHSA-86w9-cpqp-85rv` (`fixAvailable=false`), plus high `http-cache-semantics` / `source-map-js` findings. Moderate findings include the inherited `electron-builder` / `global-agent` dependency chain. These are inherited CoS dependency findings, are not silently ignored by this evidence, and remain an explicit release disposition item rather than being hidden behind a false zero-vulnerability claim.

This source evidence pins the server-side extension implementation and wire-contract build identity. It does not by itself claim live installation, replacement of the user's active CoS application, or Step-7/Step-8 live acceptance.
