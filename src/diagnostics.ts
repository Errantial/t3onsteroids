import { stat } from "node:fs/promises";
import { join } from "node:path";

import { compatibility } from "./compatibility.js";
import {
  CosControllerClient,
  discoverCosController,
  type CosControllerReadiness,
  type CosResolvedProject,
} from "./cos/index.js";

export type DiagnosticStatus = "ok" | "warn" | "error";

export interface SetupDiagnosticItem {
  readonly id: string;
  readonly status: DiagnosticStatus;
  readonly message: string;
}

export interface SetupDiagnosticsResult {
  readonly ready: boolean;
  readonly compatibility: typeof compatibility;
  readonly items: readonly SetupDiagnosticItem[];
  readonly project?: CosResolvedProject;
}

export interface SetupDiagnosticsOptions {
  readonly userDataDir: string;
  readonly cwd?: string;
  readonly discover?: typeof discoverCosController;
  readonly clientFactory?: (discover: () => Promise<Awaited<ReturnType<typeof discoverCosController>>>) => CosControllerClient;
}

export async function runSetupDiagnostics(options: SetupDiagnosticsOptions): Promise<SetupDiagnosticsResult> {
  const items: SetupDiagnosticItem[] = [];
  const discover = options.discover ?? discoverCosController;

  try {
    const controlApiDir = join(options.userDataDir, "control-api");
    const info = await stat(controlApiDir);
    items.push({ id: "control-api-dir", status: info.isDirectory() ? "ok" : "error", message: info.isDirectory() ? "CoS control-api directory is present." : "CoS control-api path is not a directory." });
  } catch {
    items.push({ id: "control-api-dir", status: "error", message: "CoS Local control API discovery directory is unavailable." });
    return { ready: false, compatibility, items };
  }

  let discovered: Awaited<ReturnType<typeof discoverCosController>>;
  try {
    discovered = await discover(options.userDataDir);
    items.push({ id: "controller-discovery", status: "ok", message: "Authenticated loopback controller endpoint discovered." });
  } catch {
    items.push({ id: "controller-discovery", status: "error", message: "CoS controller discovery failed." });
    return { ready: false, compatibility, items };
  }

  const client = options.clientFactory?.(() => Promise.resolve(discovered)) ?? new CosControllerClient(() => Promise.resolve(discovered));
  let readiness: CosControllerReadiness;
  try {
    readiness = await client.health();
    items.push({ id: "controller-health", status: "ok", message: `CoS controller protocol ${readiness.protocol} is healthy.` });
  } catch {
    items.push({ id: "controller-health", status: "error", message: "CoS controller health/compatibility check failed." });
    return { ready: false, compatibility, items };
  }

  try {
    await client.requireProviderExtension();
    items.push({
      id: "provider-extension",
      status: "ok",
      message: `Pinned CoS provider extension ${compatibility.cos.providerExtension.buildId} is available with all required v1 features.`,
    });
  } catch {
    items.push({
      id: "provider-extension",
      status: "error",
      message: `CoS provider extension does not match pinned build ${compatibility.cos.providerExtension.buildId} and required v1 features.`,
    });
  }
  items.push({
    id: "actions",
    status: readiness.actionsEnabled ? "ok" : "error",
    message: readiness.actionsEnabled ? "CoS controller actions are enabled." : "CoS controller actions are disabled.",
  });

  if (!options.cwd) {
    items.push({ id: "project", status: "warn", message: "No project cwd was supplied; exact CoS project resolution was not checked." });
  } else {
    try {
      const project = await client.resolveProject(options.cwd);
      items.push({ id: "project", status: "ok", message: "Exact CoS project root resolved successfully." });
      const ready = items.every((item) => item.status !== "error");
      return { ready, compatibility, items, project };
    } catch {
      items.push({ id: "project", status: "error", message: "Exact CoS project root could not be resolved." });
    }
  }

  return { ready: items.every((item) => item.status !== "error"), compatibility, items };
}
