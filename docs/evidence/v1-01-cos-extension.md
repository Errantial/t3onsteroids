Evidence-Schema: 1
Gate: cosProviderExtension
Status: PASS

# V1 Step 1 — CoS provider extension

Bridge implementation identity for this qualification tuple: `3cb315830850305fc7c772b497d70c1c8249a1cc`.

Final CoS `providerExtension` build identity: `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`, produced from the repaired CoS `2.1.39` lineage based on upstream source `87ae9d631f82d8da2f462d910410031ad8f97ac5`. This server/provider-extension build id is intentionally distinct from the browser-extension file stamp, which remains `a35dccb10b05` for the qualified candidate.

The qualified repair lineage after the migrated provider-extension work is: `e571a421` (`Protect closing provider turns from idle tab cleanup`) -> `e7e41572` (`Recover provider drain from transient terminal null`) -> `9056ddc0` (`Cache validated project catalog`) -> `3bd1d77b` (`Avoid duplicate provider project canonicalization`) -> `600bd789` (`Retry transient provider terminal proof`) -> `4d8ea6ac` (`Bound provider terminal proof transport`) -> `73e52028` (`Retry transient provider terminal transport`). The `e571a421` repair protects only durable provider turns in exact `closing` state from idle/blocked browser cleanup until they become `drained`, `not_sent`, or `broken`. The subsequent drain repairs recover from transient terminal-null/transport reads without substituting a timeout or silence heuristic for authoritative drain, while the project repairs cache and reuse validated canonical project state instead of repeatedly canonicalizing the same catalog entry.

The final extension advertises provider-extension API version `1`, clean build id `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`, and all four required feature ids at version `1`:

- `provider-project-resolve-v1`: `1`
- `provider-assistant-content-v1`: `1`
- `provider-session-policy-v1`: `1`
- `provider-turn-drain-v1`: `1`

Source validation observed for this exact `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc` repair:

- targeted timed-out terminal-only regression: `1/1` PASS;
- `test/provider-turn-drain.test.ts` + `test/projects.test.ts` + `test/control-api-reads.test.ts`: `101/101` PASS;
- `npm run typecheck`: PASS;
- `npm run build`: PASS;
- `git diff --check`: PASS.

The idle-close failure was a real lifecycle retention defect, not a bridge restart shortcut: a chat could reach `activeTurnId=null` while its durable provider turn was still `closing`, allowing the 300-second idle cleanup to close the browser document before `turn_drained`. On reopen, the intentionally fail-closed recovery path then rewrote that unreconciled closing provider turn to `broken`. Later Step-7 timing exposed another real terminal-proof transport tail (`1992 ms` native drain at the previous `4d8ea6ac` candidate); `73e52028` is the scoped follow-up that retries transient provider terminal transport while preserving the bounded authoritative proof contract.

Full CoS `npm run verify` is **not claimed as PASS** for this qualification evidence. The exact focused `73e52028` results above are the supported source-validation record; no later checkout or unrelated full-suite outcome should be inferred as qualified from this summary.

No provider feature was disabled or downgraded, no production assertion was relaxed, and the browser-extension stamp `a35dccb10b05` must not be confused with the repaired server/providerExtension build id `73e52028cb87ed2dd6fdc8c1a03a79669b8302bc`.

CoS dependency audit disposition is explicitly non-zero and is not represented as a clean audit. Current `npm audit` reports `14` total findings: `6` high, `8` moderate, and `0` critical. High findings include direct `@modelcontextprotocol/client@2.1.0` advisory `GHSA-6qxp-vccf-f47h` (`fixAvailable`), direct `sharp@0.35.4` advisory `GHSA-wq5f-xc86-pv6w` (fixed by `0.35.5`), and `@anthropic-ai/mcpb@2.1.2` through `node-forge@1.4.0` advisory `GHSA-86w9-cpqp-85rv` (`fixAvailable=false`), plus high `http-cache-semantics` / `source-map-js` findings. Moderate findings include the inherited `electron-builder` / `global-agent` dependency chain. These are inherited CoS dependency findings, are not silently ignored by this evidence, and remain an explicit release disposition item rather than being hidden behind a false zero-vulnerability claim.

This source evidence pins the server-side extension implementation and wire-contract build identity. It does not by itself claim live installation, replacement of the user's active CoS application, or Step-7/Step-8 live acceptance.
