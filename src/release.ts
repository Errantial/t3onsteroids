import { compatibility } from "./compatibility.js";

export interface ReleaseReadiness {
  readonly supportedConcurrency: 1;
  readonly platform: "win32-x64";
  readonly t3Pinned: true;
  readonly cosPinned: true;
  readonly controllerProtocol: 1;
  readonly productionAcpEntrypoint: false;
  readonly cosProviderExtensionReady: false;
  readonly eventTranslatorReady: false;
  readonly durableRecoveryReady: false;
  readonly liveAcceptanceRequired: true;
  readonly currentHeadDriftRequired: true;
  readonly releaseQualified: false;
}

export function releaseReadiness(): ReleaseReadiness {
  return {
    supportedConcurrency: 1,
    platform: compatibility.platform.primary,
    t3Pinned: true,
    cosPinned: true,
    controllerProtocol: compatibility.cos.controlApiProtocol,
    productionAcpEntrypoint: false,
    cosProviderExtensionReady: false,
    eventTranslatorReady: false,
    durableRecoveryReady: false,
    liveAcceptanceRequired: true,
    currentHeadDriftRequired: true,
    releaseQualified: false,
  };
}
