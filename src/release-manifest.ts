import { compatibility } from "./compatibility.js";

export type V1ReleaseGateStatus = "pending" | "pass";

export interface V1ReleaseGate {
  readonly status: V1ReleaseGateStatus;
  readonly evidencePath: string;
}

export interface CosProviderExtensionGate extends V1ReleaseGate {
  readonly extensionBuildId: typeof compatibility.cos.providerExtension.buildId | null;
  readonly featureVersions: typeof compatibility.cos.providerExtension.features;
}

export interface T3HeadDriftGate extends V1ReleaseGate {
  readonly outcome: "compatible" | "incompatible" | null;
}

export interface V1ReleaseGateManifest {
  readonly schemaVersion: 1;
  readonly gates: Readonly<{
    cosProviderExtension: CosProviderExtensionGate;
    eventTranslator: V1ReleaseGate;
    durableRecovery: V1ReleaseGate;
    acpStdio: V1ReleaseGate;
    controllerPrivacy: V1ReleaseGate;
    toolchainAudit: V1ReleaseGate;
    performance: V1ReleaseGate;
    liveAcceptance: V1ReleaseGate;
    t3HeadDrift: T3HeadDriftGate;
    releasePreparation: V1ReleaseGate;
  }>;
}

export const v1ReleaseGateManifest: V1ReleaseGateManifest = {
  schemaVersion: 1,
  gates: {
    cosProviderExtension: {
      status: "pass",
      evidencePath: "docs/evidence/v1-01-cos-extension.md",
      extensionBuildId: compatibility.cos.providerExtension.buildId,
      featureVersions: compatibility.cos.providerExtension.features,
    },
    eventTranslator: { status: "pass", evidencePath: "docs/evidence/v1-02-event-translator.md" },
    durableRecovery: { status: "pass", evidencePath: "docs/evidence/v1-03-durable-recovery.md" },
    acpStdio: { status: "pass", evidencePath: "docs/evidence/v1-04-acp-stdio.md" },
    controllerPrivacy: { status: "pass", evidencePath: "docs/evidence/v1-05-controller-privacy.md" },
    toolchainAudit: { status: "pass", evidencePath: "docs/evidence/v1-06-toolchain-audit.md" },
    performance: { status: "pass", evidencePath: "docs/evidence/v1-07-performance.md" },
    liveAcceptance: { status: "pass", evidencePath: "docs/evidence/v1-08-acceptance.md" },
    t3HeadDrift: { status: "pending", evidencePath: "docs/evidence/v1-09-release.md", outcome: null },
    releasePreparation: { status: "pending", evidencePath: "docs/evidence/v1-09-release.md" },
  },
};
