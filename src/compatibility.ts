import { BRIDGE_VERSION } from "./version.js";

export const compatibility = {
  bridge: {
    version: BRIDGE_VERSION,
  },
  t3: {
    version: "0.1.5-nightly.20261029.3877",
    sha: "6d450a4284852af137b2f3407fddd89eb76e7644",
    architecture: "orchestration-v2",
  },
  cos: {
    version: "2.1.39",
    sha: "87ae9d631f82d8da2f462d910410031ad8f97ac5",
    controlApiProtocol: 1,
    providerExtension: {
      apiVersion: 1,
      buildId: "0520fcedcd003bd89c43e649d1228333a4d2305f",
      features: {
        "provider-project-resolve-v1": 1,
        "provider-assistant-content-v1": 1,
        "provider-session-policy-v1": 1,
        "provider-turn-drain-v1": 1,
        "provider-turn-recovery-v1": 1,
      },
    },
  },
  acp: {
    sdk: "@agentclientprotocol/sdk",
    sdkVersion: "1.9.0",
  },
  platform: {
    primary: "win32-x64",
    nodeMajor: 24,
  },
} as const;

export type Compatibility = typeof compatibility;
