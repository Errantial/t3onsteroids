import { describe, expect, it } from "vitest";

import { createSessionDraft } from "../src/acp/index.js";
import { newUnboundSession } from "../src/session/index.js";

describe("Phase 0 session allocation", () => {
  it("creates bridge-local session state without requiring a CoS controller", () => {
    const draft = createSessionDraft("00000000-0000-4000-8000-000000000001", "C:\\work\\repo");
    const state = newUnboundSession(draft.sessionId);

    expect(draft.cwd).toBe("C:\\work\\repo");
    expect(state).toEqual({
      sessionId: draft.sessionId,
      bindingState: "unbound",
      interactionMode: "default",
      cancelIntent: "none",
    });
  });
});
