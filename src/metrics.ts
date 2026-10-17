export interface BridgeMetricsSnapshot {
  readonly promptReceived: number;
  readonly cosInputAcceptedOrReconciled: number;
  readonly matchingTurnEndObserved: number;
  readonly matchingTurnDrainedObserved: number;
  readonly drainHighWaterSeq: number;
  readonly acpTerminalSent: number;
  readonly controllerReadCount: number;
  readonly controllerActionCount: number;
  readonly sseConnectCount: number;
  readonly sseReconnectCount: number;
  readonly backoffCount: number;
  readonly currentQueueDepth: number;
  readonly maxQueueDepth: number;
  readonly rssHighWaterBytes: number;
  readonly lastUpdatedAt: number;
}

export class BridgeMetrics {
  private readonly startedAt = process.hrtime.bigint();
  private state: BridgeMetricsSnapshot = {
    promptReceived: 0,
    cosInputAcceptedOrReconciled: 0,
    matchingTurnEndObserved: 0,
    matchingTurnDrainedObserved: 0,
    drainHighWaterSeq: 0,
    acpTerminalSent: 0,
    controllerReadCount: 0,
    controllerActionCount: 0,
    sseConnectCount: 0,
    sseReconnectCount: 0,
    backoffCount: 0,
    currentQueueDepth: 0,
    maxQueueDepth: 0,
    rssHighWaterBytes: 0,
    lastUpdatedAt: 0,
  };

  private monotonicNowMs(): number {
    return Number((process.hrtime.bigint() - this.startedAt) / 1_000_000n);
  }

  private update(patch: Partial<BridgeMetricsSnapshot>): void {
    this.state = {
      ...this.state,
      ...patch,
      rssHighWaterBytes: Math.max(this.state.rssHighWaterBytes, process.memoryUsage().rss),
      lastUpdatedAt: Math.max(this.state.lastUpdatedAt, this.monotonicNowMs()),
    };
  }

  increment(field: keyof Pick<BridgeMetricsSnapshot,
    "promptReceived" |
    "cosInputAcceptedOrReconciled" |
    "matchingTurnEndObserved" |
    "matchingTurnDrainedObserved" |
    "acpTerminalSent" |
    "controllerReadCount" |
    "controllerActionCount" |
    "sseConnectCount" |
    "sseReconnectCount" |
    "backoffCount"
  >): void {
    this.update({ [field]: this.state[field] + 1 } as Partial<BridgeMetricsSnapshot>);
  }

  observeDrainHighWater(seq: number): void {
    this.update({ drainHighWaterSeq: Math.max(this.state.drainHighWaterSeq, seq) });
  }

  observeQueueDepth(current: number, max: number): void {
    this.update({ currentQueueDepth: current, maxQueueDepth: Math.max(this.state.maxQueueDepth, max) });
  }

  snapshot(): BridgeMetricsSnapshot {
    this.update({});
    return { ...this.state };
  }
}
