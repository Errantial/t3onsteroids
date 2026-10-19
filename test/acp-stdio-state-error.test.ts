import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { safeRequestError } from "../src/acp/stdio.js";
import { StateIoError } from "../src/state/index.js";

describe("ACP stdio state I/O error boundary", () => {
  it("maps durable state I/O failures to a stable typed ACP error without filesystem details", () => {
    const source = Object.assign(new Error("EACCES C:\\private\\state\\session.json"), { code: "EACCES" });

    try {
      safeRequestError(new StateIoError("read", source));
      throw new Error("expected safeRequestError to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(acp.RequestError);
      expect(error).toMatchObject({
        code: -32000,
        message: "Bridge request failed",
        data: { code: "state_io_error" },
      });
      expect(JSON.stringify(error)).not.toContain("private");
      expect(JSON.stringify(error)).not.toContain("session.json");
    }
  });
});
