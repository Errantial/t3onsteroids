import { describe, expect, it, vi } from "vitest";

import {
  AcpBridgeRuntime,
  BridgeError,
  MAX_COS_INPUT_CHARS,
  normalizePrompt,
  type BridgeController,
} from "../src/acp/index.js";
import { MemoryStateStore } from "../src/state/index.js";
import type { SessionState } from "../src/session/index.js";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeController(): BridgeController & { resolveProject: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  return {
    requireBackgroundWorkDisabled: vi.fn(async () => ({ backgroundWork: "disabled" as const, enforced: true as const })),
    resolveProject: vi.fn(async () => ({ projectId: "project-1", canonicalPath: "C:\\repo" })),
    input: vi.fn(async () => undefined),
    send: vi.fn(async (input) => ({ id: input.id, sessionId: input.sessionId ?? input.id, delivery: "sent" as const })),
  };
}

describe("Phase 3 ACP shell and lazy binding", () => {
  it("keeps session/new side-effect free and advertises only implemented capabilities", () => {
    const controller = makeController();
    const runtime = new AcpBridgeRuntime({
      controller,
      store: new MemoryStateStore<SessionState>(),
      makeUuid: () => sessionId,
      canonicalize: async (path) => path,
    });

    expect(runtime.initialize(1)).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {}, sessionCapabilities: { resume: {} } },
    });
    expect(runtime.newSession({ cwd: "C:\\repo", mcpServers: [] })).toEqual({ sessionId });
    expect(controller.resolveProject).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("always negotiates the shipped stable ACP v1 response even when the client requests numeric version 2", () => {
    const runtime = new AcpBridgeRuntime({
      controller: makeController(),
      store: new MemoryStateStore<SessionState>(),
    });

    expect(runtime.initialize(2)).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {}, sessionCapabilities: { resume: {} } },
    });
  });

  it("rejects additionalDirectories before any controller mutation", async () => {
    const controller = makeController();
    const runtime = new AcpBridgeRuntime({ controller, store: new MemoryStateStore<SessionState>(), makeUuid: () => sessionId });
    expect(() => runtime.newSession({ cwd: "C:\\repo", mcpServers: [], additionalDirectories: ["C:\\other"] })).toThrowError(BridgeError);
    await expect(runtime.resumeSession({ sessionId, cwd: "C:\\repo", additionalDirectories: ["C:\\other"] })).rejects.toMatchObject({ code: "additional_directories_unsupported" });
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("accepts but does not forward T3-injected MCP metadata", async () => {
    const controller = makeController();
    const runtime = new AcpBridgeRuntime({ controller, store: new MemoryStateStore<SessionState>(), makeUuid: () => sessionId });
    expect(runtime.newSession({
      cwd: "C:\\repo",
      mcpServers: [{ name: "t3-code", command: "example", args: [], env: [] }],
    })).toEqual({ sessionId });
    await expect(runtime.resumeSession({
      sessionId,
      cwd: "C:\\repo",
      mcpServers: [{ name: "t3-code", command: "example", args: [], env: [] }],
    })).resolves.toEqual({});
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("creates the CoS session lazily on first prompt with matching UUID then reuses it", async () => {
    const controller = makeController();
    const ids = [sessionId, secondId];
    const runtime = new AcpBridgeRuntime({
      controller,
      store: new MemoryStateStore<SessionState>(),
      makeUuid: () => ids.shift()!,
      canonicalize: async (path) => path,
    });
    runtime.newSession({ cwd: "C:\\repo", mcpServers: [] });

    await runtime.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
    await runtime.prompt({ sessionId, prompt: [{ type: "text", text: "second" }] });

    expect(controller.send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: sessionId,
      projectId: "project-1",
      providerPolicy: { backgroundWork: "disabled" },
    }));
    expect(controller.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: secondId,
      sessionId,
    }));
  });

  it("creates a worktree session with its workspace and reuses it without resending the workspace", async () => {
    const controller = makeController();
    const workspace = "C:\\repo\\.worktrees\\feature";
    controller.resolveProject.mockResolvedValue({
      projectId: "project-1",
      canonicalPath: workspace,
      kind: "worktree",
      sourceProjectPath: "C:\\repo",
    });
    const ids = [sessionId, secondId];
    const runtime = new AcpBridgeRuntime({
      controller,
      store: new MemoryStateStore<SessionState>(),
      makeUuid: () => ids.shift()!,
      canonicalize: async (path) => path,
    });
    runtime.newSession({ cwd: workspace, mcpServers: [] });

    await runtime.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
    await runtime.prompt({ sessionId, prompt: [{ type: "text", text: "second" }] });

    expect(controller.send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: sessionId,
      projectId: "project-1",
      workspacePath: workspace,
      providerPolicy: { backgroundWork: "disabled" },
    }));
    expect(controller.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: secondId,
      sessionId,
    }));
    expect(controller.send.mock.calls[1]?.[0]).not.toHaveProperty("workspacePath");
  });

  it("advertises the controller model catalog and applies a selected model to prompts", async () => {
    const controller = makeController();
    controller.models = vi.fn(async () => ({
      state: "ready" as const,
      observedAt: 1,
      models: [
        { id: "gpt-6-thinking", label: "GPT-6 Thinking", efforts: ["low", "high"] },
        { id: "gpt-6-pro", label: "GPT-6 Pro", efforts: ["pro"] },
      ],
    }));
    const ids = [sessionId, secondId];
    const runtime = new AcpBridgeRuntime({
      controller,
      store: new MemoryStateStore<SessionState>(),
      makeUuid: () => ids.shift()!,
      canonicalize: async (path) => path,
    });
    runtime.newSession({ cwd: "C:\\repo", mcpServers: [] });

    await expect(runtime.modelConfigOptions(sessionId)).resolves.toMatchObject([
      { id: "model", category: "model", currentValue: "gpt-6-thinking" },
      { id: "thought_level", category: "thought_level", currentValue: "low" },
    ]);
    await expect(runtime.setConfigOption({ sessionId, configId: "model", value: "gpt-6-pro" })).resolves.toMatchObject([
      { id: "model", currentValue: "gpt-6-pro" },
      { id: "thought_level", currentValue: "pro" },
    ]);
    await runtime.prompt({ sessionId, prompt: [{ type: "text", text: "use the selected model" }] });
    expect(controller.send).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-6-pro",
      reasoningEffort: "pro",
    }));
    await expect(runtime.setConfigOption({ sessionId, configId: "model", value: "not-a-model" }))
      .rejects.toMatchObject({ code: "unsupported_model" });
    await expect(runtime.setConfigOption({ sessionId, configId: "unknown", value: "x" }))
      .rejects.toMatchObject({ code: "unsupported_config_option" });
  });

  it("persists create_pending before the first POST", async () => {
    const controller = makeController();
    const store = new MemoryStateStore<SessionState>();
    controller.send.mockImplementation(async () => {
      const pending = await store.read(sessionId);
      expect(pending).toMatchObject({ bindingState: "create_pending", activeInputId: sessionId, cosProjectId: "project-1" });
      throw new TypeError("ambiguous dispatch");
    });
    const runtime = new AcpBridgeRuntime({ controller, store, makeUuid: () => sessionId, canonicalize: async (path) => path });
    runtime.newSession({ cwd: "C:\\repo", mcpServers: [] });

    await expect(runtime.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })).rejects.toThrow(/ambiguous dispatch/);
    await expect(store.read(sessionId)).resolves.toMatchObject({ bindingState: "create_pending", activeInputId: sessionId });
  });

  it("reconciles create_pending before allowing a subsequent send", async () => {
    const controller = makeController();
    const store = new MemoryStateStore<SessionState>();
    await store.write(sessionId, {
      sessionId,
      cwd: "C:\\repo",
      bindingState: "create_pending",
      interactionMode: "default",
      canonicalCwd: "C:\\repo",
      cosProjectId: "project-1",
      activeInputId: sessionId,
    });
    controller.input.mockResolvedValue({ id: sessionId, sessionId, delivery: "sent" });
    const runtime = new AcpBridgeRuntime({ controller, store, makeUuid: () => secondId, canonicalize: async (path) => path });

    await runtime.prompt({ sessionId, prompt: [{ type: "text", text: "after crash" }] });

    expect(controller.input).toHaveBeenCalledWith(sessionId);
    expect(controller.send).toHaveBeenCalledTimes(1);
    expect(controller.send).toHaveBeenCalledWith(expect.objectContaining({ id: secondId, sessionId }));
  });

  it("resume before first prompt creates no CoS chat", async () => {
    const controller = makeController();
    const runtime = new AcpBridgeRuntime({ controller, store: new MemoryStateStore<SessionState>(), canonicalize: async (path) => path });
    await expect(runtime.resumeSession({ sessionId, cwd: "C:\\repo" })).resolves.toEqual({});
    expect(controller.resolveProject).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("normalizes known T3 wrapper/runtime blocks and preserves plan mode", async () => {
    const canonicalize = async (path: string) => path;
    const first = await normalizePrompt([
      { type: "text", text: "<t3_code_instructions>\nmode plan\n</t3_code_instructions>\n\n<user_request>\ninspect only\n</user_request>" },
      { type: "text", text: "runtime_info pull_request_linking host-only data" },
    ], "default", "C:\\repo", canonicalize);
    expect(first.interactionMode).toBe("plan");
    expect(first.text).toContain("Plan mode: investigate read-only and return a plan.");
    expect(first.text).toContain("inspect only");
    expect(first.text).not.toContain("runtime_info");

    const next = await normalizePrompt([{ type: "text", text: "continue" }], first.interactionMode, "C:\\repo", canonicalize);
    expect(next.interactionMode).toBe("plan");
    expect(next.text).toContain("Plan mode:");

    const back = await normalizePrompt([
      { type: "text", text: "<t3_code_instructions>\nmode default\n</t3_code_instructions>\n\n<user_request>\nimplement now\n</user_request>" },
    ], next.interactionMode, "C:\\repo", canonicalize);
    expect(back.interactionMode).toBe("default");
    expect(back.text).toBe("implement now");
  });

  it("fails closed for wrapper drift, slash commands, and unsupported content", async () => {
    await expect(normalizePrompt([{ type: "text", text: "<t3_code_instructions>broken" }], "default", "C:\\repo", async (path) => path)).rejects.toMatchObject({ code: "t3_prompt_contract_mismatch" });
    await expect(normalizePrompt([{ type: "text", text: "/compact" }], "default", "C:\\repo", async (path) => path)).rejects.toMatchObject({ code: "unsupported_command" });
    await expect(normalizePrompt([{ type: "image", data: "AA==", mimeType: "image/png" }], "default", "C:\\repo", async (path) => path)).rejects.toMatchObject({ code: "unsupported_prompt_content" });
  });

  it("accepts only in-root local file ResourceLinks", async () => {
    const canonicalize = async (path: string) => path.replaceAll("/", "\\");
    const accepted = await normalizePrompt([
      { type: "resource_link", name: "file", uri: "file:///C:/repo/docs/readme.md" },
    ], "default", "C:\\repo", canonicalize);
    expect(accepted.text).toContain("C:\\\\repo\\\\docs\\\\readme.md");

    await expect(normalizePrompt([
      { type: "resource_link", name: "bad", uri: "https://example.com/a" },
    ], "default", "C:\\repo", canonicalize)).rejects.toMatchObject({ code: "resource_link_unavailable" });
    await expect(normalizePrompt([
      { type: "resource_link", name: "bad", uri: "file://server/share/a" },
    ], "default", "C:\\repo", canonicalize)).rejects.toMatchObject({ code: "resource_link_unavailable" });
    await expect(normalizePrompt([
      { type: "resource_link", name: "bad", uri: "file:///C:/other/a" },
    ], "default", "C:\\repo", canonicalize)).rejects.toMatchObject({ code: "resource_link_unavailable" });
  });

  it("enforces the exact 64,000-character admission boundary before send", async () => {
    await expect(normalizePrompt([{ type: "text", text: "x".repeat(MAX_COS_INPUT_CHARS) }], "default", "C:\\repo", async (path) => path)).resolves.toMatchObject({ text: "x".repeat(MAX_COS_INPUT_CHARS) });
    await expect(normalizePrompt([{ type: "text", text: "x".repeat(MAX_COS_INPUT_CHARS + 1) }], "default", "C:\\repo", async (path) => path)).rejects.toMatchObject({ code: "input_too_large" });
  });
});
