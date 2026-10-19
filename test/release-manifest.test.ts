import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { compatibility } from "../src/compatibility.js";
import { v1ReleaseGateManifest } from "../src/release-manifest.js";
import { releaseReadiness } from "../src/release.js";

const expectedEvidencePaths = {
  cosProviderExtension: "docs/evidence/v1-01-cos-extension.md",
  eventTranslator: "docs/evidence/v1-02-event-translator.md",
  durableRecovery: "docs/evidence/v1-03-durable-recovery.md",
  acpStdio: "docs/evidence/v1-04-acp-stdio.md",
  controllerPrivacy: "docs/evidence/v1-05-controller-privacy.md",
  toolchainAudit: "docs/evidence/v1-06-toolchain-audit.md",
  performance: "docs/evidence/v1-07-performance.md",
  liveAcceptance: "docs/evidence/v1-08-acceptance.md",
  t3HeadDrift: "docs/evidence/v1-09-release.md",
  releasePreparation: "docs/evidence/v1-09-release.md",
} as const;

function evidenceHasPassBlock(evidencePath: string, gate: string): boolean {
  const full = path.join(process.cwd(), evidencePath);
  if (!existsSync(full)) return false;
  const text = readFileSync(full, "utf8");
  const escapedGate = gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)Evidence-Schema: 1\\r?\\nGate: ${escapedGate}\\r?\\nStatus: PASS(?:\\r?\\n|$)`).test(text);
}

describe("v1 release gate manifest", () => {
  it("uses the canonical evidence paths and requires matching PASS evidence for every passed gate", () => {
    expect(v1ReleaseGateManifest.schemaVersion).toBe(1);
    for (const [gateName, gate] of Object.entries(v1ReleaseGateManifest.gates)) {
      expect(gate.evidencePath).toBe(expectedEvidencePaths[gateName as keyof typeof expectedEvidencePaths]);
      if (gate.status === "pass") expect(evidenceHasPassBlock(gate.evidencePath, gateName)).toBe(true);
    }
  });

  it("keeps provider extension and drift metadata valid whenever those gates pass", () => {
    const extension = v1ReleaseGateManifest.gates.cosProviderExtension;
    if (extension.status === "pass") {
      expect(extension.extensionBuildId).toBe(compatibility.cos.providerExtension.buildId);
      expect(extension.featureVersions).toEqual(compatibility.cos.providerExtension.features);
    }

    const drift = v1ReleaseGateManifest.gates.t3HeadDrift;
    if (drift.status === "pass") expect(["compatible", "incompatible"]).toContain(drift.outcome);
  });

  it("derives readiness from the manifest and cannot qualify while any gate is pending", () => {
    const readiness = releaseReadiness();
    const allPassed = Object.values(v1ReleaseGateManifest.gates).every((gate) => gate.status === "pass");
    expect(readiness.cosProviderExtensionReady).toBe(v1ReleaseGateManifest.gates.cosProviderExtension.status === "pass");
    expect(readiness.eventTranslatorReady).toBe(v1ReleaseGateManifest.gates.eventTranslator.status === "pass");
    expect(readiness.durableRecoveryReady).toBe(v1ReleaseGateManifest.gates.durableRecovery.status === "pass");
    expect(readiness.productionAcpEntrypoint).toBe(v1ReleaseGateManifest.gates.acpStdio.status === "pass");
    expect(readiness.liveAcceptanceRequired).toBe(v1ReleaseGateManifest.gates.liveAcceptance.status !== "pass");
    expect(readiness.currentHeadDriftRequired).toBe(v1ReleaseGateManifest.gates.t3HeadDrift.status !== "pass");
    expect(readiness.releaseQualified).toBe(allPassed);
    if (!allPassed) expect(readiness.releaseQualified).toBe(false);
  });
});
