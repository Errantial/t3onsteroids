import { it, assert } from "@effect/vitest";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as AcpClient from "./client.ts";

const bridge = String.raw`C:\Users\Emil\t3onsteroids-post-v1\dist\cli\index.js`;
const repo = String.raw`C:\Users\Emil\t3onsteroids-post-v1`;
const profile = String.raw`C:\Users\Emil\t3onsteroids-post-v1\.local-evidence\post-v1-concurrency\cos-profile-live-01`;
const state = String.raw`C:\Users\Emil\t3onsteroids-post-v1\.local-evidence\post-v1-concurrency\t3head-bridge-state`;

it.layer(NodeServices.layer)("T3-HEAD ACP client against the bridge", (it) => {
  it.effect(
    "initializes, creates a session and completes one prompt",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [bridge], {
            cwd: repo,
            env: {
              ...process.env,
              T3ONSTEROIDS_COS_USER_DATA_DIR: profile,
              T3ONSTEROIDS_STATE_DIR: state,
            },
          }),
        );
        const result = yield* Effect.gen(function* () {
          const acp = yield* AcpClient.AcpClient;
          const initialized = yield* acp.agent.initialize({ protocolVersion: 2 });
          const created = yield* acp.agent.createSession({ cwd: repo, mcpServers: [] });
          const response = yield* acp.agent.prompt({
            sessionId: created.sessionId,
            prompt: [{ type: "text", text: "Reply with exactly T3HEADOK and nothing else." }],
          });
          return { initialized, created, response };
        }).pipe(Effect.provide(AcpClient.layerChildProcess(handle)));
        assert.equal(result.initialized.protocolVersion, 1);
        assert.ok(result.created.sessionId.length >= 8);
        assert.equal(result.response.stopReason, "end_turn");
      }),
    { timeout: 240_000 },
  );
});
