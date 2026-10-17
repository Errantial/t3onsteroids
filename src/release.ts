import { compatibility } from "./compatibility.js";
import { BRIDGE_VERSION } from "./version.js";

export interface ReleaseReadiness {
  readonly bridgeVersion: string;
  readonly supportedConcurrency: 1;
  readonly platform: "win32-x64";
  readonly t3Pinned: true;
  readonly cosPinned: true;
  readonly controllerProtocol: 1;
  readonly productionAcpEntrypoint: true;
  readonly cosProviderExtensionReady: true;
  readonly eventTranslatorReady: true;
  readonly durableRecoveryReady: true;
  readonly liveAcceptanceRequired: true;
  readonly currentHeadDriftRequired: true;
  readonly releaseQualified: false;
}

export function releaseReadiness(): ReleaseReadiness {
  return {
    bridgeVersion: BRIDGE_VERSION,
    supportedConcurrency: 1,
    platform: compatibility.platform.primary,
    t3Pinned: true,
    cosPinned: true,
    controllerProtocol: compatibility.cos.controlApiProtocol,
    productionAcpEntrypoint: true,
    cosProviderExtensionReady: true,
    eventTranslatorReady: true,
    durableRecoveryReady: true,
    liveAcceptanceRequired: true,
    currentHeadDriftRequired: true,
    releaseQualified: false,
  };
}
