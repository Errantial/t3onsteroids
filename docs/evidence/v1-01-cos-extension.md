Evidence-Schema: 1
Gate: cosProviderExtension
Status: PASS

# V1 Step 1 — CoS provider extension

Bridge implementation identity for this qualification tuple: `5c8fcce4c4962b6c671046fc12ae662c631b2f1a`.

Final CoS `providerExtension` build identity: `e571a421b3aa1b43acec3efc9695f5081cc224b0`, produced from a clean committed CoS tree based on CoS `2.1.39` / upstream source `87ae9d631f82d8da2f462d910410031ad8f97ac5`. This server/provider-extension build id is intentionally distinct from the browser-extension file stamp: no `extension/` file changed in the repair, so the browser-extension stamp remains `a8e3d21511dc`.

The qualified lineage preserves the exact historical migrated provider-extension implementation at `d5f27e7486c977351401ab1801fb01112aa2919b`, followed by the scoped qualification repairs `eb3ff475` (delivery durability), `0893fbdf` (fixture-only), and final repair `e571a421` (`Protect closing provider turns from idle tab cleanup`). The delivery repair preserves frozen `deliveryText` / Goal transport bytes across history publication, restart, and backend changes while retaining terminal-receipt compaction. The final repair changes `src/main/bridge.ts` plus one bridge regression: durable provider turns in exact `closing` state are added to the protected-chat set after generic blocked-chat cleanup so idle/blocked browser-tab cleanup cannot destroy the owner while the two-phase drain is still pending. Protection disappears once the provider turn becomes `drained`, `not_sent`, or `broken`, so unrelated chat lifetime and post-drain close behavior remain unchanged.

The final extension advertises provider-extension API version `1`, clean build id `e571a421b3aa1b43acec3efc9695f5081cc224b0`, and all four required feature ids at version `1`:

- `provider-project-resolve-v1`: `1`
- `provider-assistant-content-v1`: `1`
- `provider-session-policy-v1`: `1`
- `provider-turn-drain-v1`: `1`

Source validation completed for this exact repaired lineage:

- focused new idle-close closing-turn regression: PASS;
- `test/provider-turn-drain.test.ts`: `9/9` PASS;
- full `test/bridge.test.ts`: `692/692` PASS;
- `npm run typecheck`: PASS;
- `npm run build`: PASS;
- bridge-side focused provider contract `test/cos-provider-extension.test.ts`: `11/11` PASS against build id `e571a421b3aa1b43acec3efc9695f5081cc224b0`.

The idle-close failure was a real lifecycle retention defect, not a bridge restart shortcut: a chat could reach `activeTurnId=null` while its durable provider turn was still `closing`, allowing the 300-second idle cleanup to close the browser document before `turn_drained`. On reopen, the intentionally fail-closed recovery path then rewrote that unreconciled closing provider turn to `broken`. The `e571a421` repair protects only that exact closing interval and keeps the authoritative drain fence intact; it does not replace drain with a timeout/silence heuristic, relax provider policy, or weaken recovery semantics.

The latest full CoS `npm run verify` attempt is **not recorded as a new full-suite PASS**. That attempt had only the already-known load-sensitive input-delivery prompt-freeze timing miss; the exact affected case is being rerun separately. The focused regression, provider-turn-drain suite, full bridge test file, typecheck and build results above are the current repaired-source results. Do not infer a fresh full-CoS-verify PASS from this evidence until that result is explicitly recorded.

No provider feature was disabled or downgraded, no production assertion was relaxed, and the unchanged browser-extension stamp `a8e3d21511dc` must not be confused with the repaired server/providerExtension build id `e571a421b3aa1b43acec3efc9695f5081cc224b0`.

CoS dependency audit disposition is explicitly non-zero and is not represented as a clean audit. Current `npm audit` reports `14` total findings: `6` high, `8` moderate, and `0` critical. High findings include direct `@modelcontextprotocol/client@2.1.0` advisory `GHSA-6qxp-vccf-f47h` (`fixAvailable`), direct `sharp@0.35.4` advisory `GHSA-wq5f-xc86-pv6w` (fixed by `0.35.5`), and `@anthropic-ai/mcpb@2.1.2` through `node-forge@1.4.0` advisory `GHSA-86w9-cpqp-85rv` (`fixAvailable=false`), plus high `http-cache-semantics` / `source-map-js` findings. Moderate findings include the inherited `electron-builder` / `global-agent` dependency chain. These are inherited CoS dependency findings, are not silently ignored by this evidence, and remain an explicit release disposition item rather than being hidden behind a false zero-vulnerability claim.

This source evidence pins the server-side extension implementation and wire-contract build identity. It does not by itself claim live installation, replacement of the user's active CoS application, or Step-7/Step-8 live acceptance.
