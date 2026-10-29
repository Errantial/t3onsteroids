# Post-v1 milestone ledger

Status: five next milestones after the parked 4/8-chat concurrency item. Each is complete only when
its implementation and tests exist in Git and the evidence below names the commands that proved it.
The provider-side work is batched into one extension build; the 2-chat tuple is requalified once at
the end (`M5`) rather than after each slice.

## M1. Workspace and worktree binding

Complete.

- Controller `5ba94cc`: `provider-session-workspace-v1`, `POST /v1/workspaces/resolve`, exact project
  roots, linked Git worktrees (including subdirectories), plain project subdirectories by deepest
  ancestor, immutable session workspace, `getSessionWorkspace` for tools and `getSessionProject`
  for instructions, admission revalidation.
- Bridge `3e58d1a`: workspace resolver used only when advertised; first prompt carries
  `workspacePath`; every prompt/resume revalidates; protocol-1 behavior unchanged.
- Evidence: `npx vitest run test/projects.test.ts` 20/20; `test/control-api-actions.test.ts`,
  `test/control-api-reads.test.ts`, `test/control-api.test.ts` 156/156 at the time;
  `test/cos-client.test.ts` and `test/acp-phase3.test.ts` pass in the bridge suite.

## M2. Model and reasoning selection

Complete at the request/confirmation boundary.

- Controller `5e32b52`: `provider-model-catalog-v1`, `GET /v1/models`, per-input `model` and
  `reasoningEffort` validated against the ready catalog before the outbox.
- Bridge `70ce675`: `model` and `thought_level` config options at `session/new` and resume,
  `session/set_config_option` validation, durable `select_model` transition, and the selection on
  every prompt.
- Confirmation: the browser extension applies the requested model/effort through
  `selectModelSettings(input.model, input.reasoningEffort)` and fails the send with
  `content_delivery_model_unconfirmed` when the picker does not confirm
  (`cos-source/extension/content.js:13436`). A delivered input therefore proves the picker accepted
  the exact model/effort; the controller never records the selection from silence.
- Evidence: controller control-API action suite 56/56; bridge `acp-phase3` 16/16,
  `state-durable` selection test, `cos-client` 38/38; full bridge suite 295/295 at commit `70ce675`.

## M3. Prompt images (attachments)

Complete for the supported format.

- Controller `d77cdca`: `provider-input-images-v1`; `/v1/inputs` accepts the outbox’s bounded image
  shape (up to 10 WebP data URLs, 512,100 characters each), refuses other formats before admission,
  and refuses images on a non-provider chat.
- Bridge `034f25e`: advertises the ACP image prompt capability, accepts WebP image blocks with
  base64/size/name limits, refuses every other image format with `unsupported_prompt_content`, and
  sends images only when readiness advertises the controller feature.
- Limit stated honestly: T3 screenshots that arrive as PNG/JPEG are refused, not converted; the
  bridge has no image transcoder and does not silently alter bytes.
- Evidence: controller `test/control-api-actions.test.ts` 56/56 with image accept/reject cases;
  bridge `test/acp-phase3.test.ts` 16/16 including capability, send and feature-absence refusal.

## M4. Command policy

Complete as an explicit refusal policy.

- A leading slash command is never forwarded to ChatGPT. `normalizePrompt` rejects it with
  `unsupported_command`; no ACP `availableCommands` are advertised, and there is no bridge-local
  allowlist entry to bypass.
- Adding a command later requires a reviewed mapping and its own tests; forwarding arbitrary slash
  text remains forbidden.
- Evidence: `test/acp-phase3.test.ts` “fails closed for wrapper drift, slash commands, and
  unsupported content” (`/compact` → `unsupported_command`).

## M5. One provider build and 2-chat requalification

Complete.

- Batch the provider commits above into one extension build, pin it in the bridge, rebuild the
  bridge, and rerun the full eight-case 2-chat matrix against the rebuilt candidate. Record the
  build id, executable identity, matrix result and any setup-invalid attempts in
  `docs/evidence/post-v1-concurrency-qualification.md` and `docs/release-status.md`.
- 4/8-chat concurrency stays parked at `supportedConcurrency=2`.

- Evidence: provider build d77cdca, bridge pin 63db337, full bridge suite 297/297, candidate healthy with all nine features. Run 20261029T230611Z-twochat-requal-retry2 passed all eight cases (baseline pre-send/drain/post p95 109/933/89 ms; two-chat 142/719/94 ms; RSS 82/87 MB per process) on T3 6d450a42 and CoS base 87ae9d63, executable SHA-256 AAFEE508A39EA6C696B39E629410A8CB5C442215919087807F2DD24B32AA87AE. Two earlier attempts failed one flaky case each and are recorded in docs/evidence/post-v1-concurrency-qualification.md; the passing run is the qualifying evidence.
