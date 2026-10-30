import { compatibility } from "./compatibility.js";
import { v1ReleaseGateManifest } from "./release-manifest.js";
import { BRIDGE_VERSION } from "./version.js";

export interface ReleaseReadiness {
  readonly bridgeVersion: string;
  readonly supportedConcurrency: 1 | 2 | 4;
  readonly platform: "win32-x64";
  readonly t3Pinned: true;
  readonly cosPinned: true;
  readonly controllerProtocol: 1;
  readonly productionAcpEntrypoint: boolean;
  readonly cosProviderExtensionReady: boolean;
  readonly eventTranslatorReady: boolean;
  readonly durableRecoveryReady: boolean;
  readonly liveAcceptanceRequired: boolean;
  readonly currentHeadDriftRequired: boolean;
  readonly t3BaselineQualified: boolean;
  readonly releaseQualified: boolean;
}

export function releaseReadiness(): ReleaseReadiness {
  const gates = v1ReleaseGateManifest.gates;
  // Every historical gate can stay green while the working tree targets a newer T3 baseline than
  // the one that was live-qualified. Keep the tuple check separate from the gate roll-up so the
  // release claim cannot silently widen to a baseline nobody exercised.
  const t3BaselineQualified = v1ReleaseGateManifest.qualifiedT3Sha === compatibility.t3.sha;
  const releaseQualified = t3BaselineQualified &&
    Object.values(gates).every((gate) => gate.status === "pass");
  return {
    bridgeVersion: BRIDGE_VERSION,
    supportedConcurrency: 2,
    platform: compatibility.platform.primary,
    t3Pinned: true,
    cosPinned: true,
    controllerProtocol: compatibility.cos.controlApiProtocol,
    productionAcpEntrypoint: gates.acpStdio.status === "pass",
    cosProviderExtensionReady: gates.cosProviderExtension.status === "pass",
    eventTranslatorReady: gates.eventTranslator.status === "pass",
    durableRecoveryReady: gates.durableRecovery.status === "pass",
    liveAcceptanceRequired: gates.liveAcceptance.status !== "pass" || !t3BaselineQualified,
    currentHeadDriftRequired: gates.t3HeadDrift.status !== "pass",
    t3BaselineQualified,
    releaseQualified,
  };
}
