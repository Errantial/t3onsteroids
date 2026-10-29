export function parseOptions(argv: string[]): Record<string, string>;
export function requiredOption(options: Record<string, string>, name: string): string;
export function createNewEvidenceRoot(path: string): Promise<string>;
export function writeEvidence(path: string, value: unknown): Promise<void>;
export function readJson(path: string): Promise<unknown>;
export function browserHealthy(snapshot: unknown): boolean;
export function providerBrowserReady(snapshot: unknown): boolean;
export function summarizeStatus(status: unknown): { connectionState: string | null; bridgePaired: boolean; bridgePresent: boolean };
export function isRestartCheckpointLifecycleUpdate(update: unknown): boolean;
export function buildCrossSessionStaleFixture(sourceEvents: readonly unknown[], targetEvents: readonly unknown[], sourceSessionId: string): {
  fixture: Record<string, unknown>;
  sourceEventSequence: number;
  targetLastSeq: number;
} | null;
export function controllerMetadata(discovery: { baseUrl: string; token: string }): Promise<{ connectionState: string | null; bridgePaired: boolean; bridgePresent: boolean; inputCount: number }>;
export function proveProviderSessionInputs(events: readonly unknown[], expectedCount: number): boolean;
export function aggregateBridgeMetrics(...snapshots: unknown[]): Record<string, number>;
export function evaluateSseReconnectEvidence(evidence: unknown): { pass: boolean; checks: Record<string, boolean> };
export function evaluateRestartEvidence(evidence: unknown): { pass: boolean; checks: Record<string, boolean> };
