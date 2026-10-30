export interface BridgeMetricsSnapshot {
  readonly promptReceived: number;
  readonly cosInputAcceptedOrReconciled: number;
  readonly matchingTurnEndObserved: number;
  /** Native work registered as a follow-up instead of failing the turn. */
  readonly followUpsRegistered: number;
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
  readonly recentTurns: readonly BridgeTurnTimingReceipt[];
}

export interface BridgeTurnTimingReceipt {
  readonly sessionKey: string;
  readonly generation: number;
  readonly promptReceivedAt: number;
  readonly cosInputAcceptedAt?: number;
  readonly turnEndAt?: number;
  readonly turnDrainedAt?: number;
  readonly acpTerminalSentAt?: number;
  readonly preSendMs?: number;
  readonly drainMs?: number;
  readonly postDrainMs?: number;
  readonly preSendPhases?: BridgePreSendPhaseTimings;
}

export interface BridgePreSendPhaseTimings {
  readonly persistedReadMs: number;
  readonly projectResolveMs: number;
  readonly promptNormalizeMs: number;
  readonly readinessMs: number;
  readonly durablePrepareMs: number;
  readonly leaseAcquireMs: number;
  readonly markDispatchedMs: number;
  readonly inputSendMs: number;
}

const MAX_RECENT_TURNS = 32;

export class BridgeMetrics {
  private readonly startedAt = process.hrtime.bigint();
  private state: BridgeMetricsSnapshot = {
    promptReceived: 0,
    cosInputAcceptedOrReconciled: 0,
    matchingTurnEndObserved: 0,
  followUpsRegistered: 0,
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
    recentTurns: [],
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

  private sessionKey(sessionId: string): string {
    let hash = 2166136261;
    for (let index = 0; index < sessionId.length; index += 1) {
      hash ^= sessionId.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  monotonicTimestampMs(): number {
    return this.monotonicNowMs();
  }

  private updateTiming(sessionId: string, generation: number, patch: Partial<BridgeTurnTimingReceipt>): void {
    const current = [...this.state.recentTurns];
    const sessionKey = this.sessionKey(sessionId);
    const index = current.findIndex((receipt) => receipt.sessionKey === sessionKey && receipt.generation === generation);
    const existing = index >= 0 ? current[index]! : undefined;
    const next: BridgeTurnTimingReceipt = {
      sessionKey,
      generation,
      promptReceivedAt: existing?.promptReceivedAt ?? this.monotonicNowMs(),
      ...existing,
      ...patch,
    };
    const derived: BridgeTurnTimingReceipt = {
      ...next,
      ...(next.cosInputAcceptedAt === undefined ? {} : { preSendMs: next.cosInputAcceptedAt - next.promptReceivedAt }),
      ...(next.turnEndAt === undefined || next.turnDrainedAt === undefined ? {} : { drainMs: next.turnDrainedAt - next.turnEndAt }),
      ...(next.turnDrainedAt === undefined || next.acpTerminalSentAt === undefined ? {} : { postDrainMs: next.acpTerminalSentAt - next.turnDrainedAt }),
    };
    if (index >= 0) current[index] = derived;
    else current.push(derived);
    this.update({ recentTurns: current.slice(-MAX_RECENT_TURNS) });
  }

  beginTurn(sessionId: string, generation: number, promptReceivedAt = this.monotonicNowMs()): void {
    this.updateTiming(sessionId, generation, { promptReceivedAt });
  }

  observePreSendPhases(sessionId: string, generation: number, phases: BridgePreSendPhaseTimings): void {
    this.updateTiming(sessionId, generation, { preSendPhases: { ...phases } });
  }

  markTurn(sessionId: string, generation: number, transition: "cos_input_accepted" | "turn_end" | "turn_drained" | "acp_terminal_sent"): void {
    const now = this.monotonicNowMs();
    switch (transition) {
      case "cos_input_accepted": this.updateTiming(sessionId, generation, { cosInputAcceptedAt: now }); break;
      case "turn_end": this.updateTiming(sessionId, generation, { turnEndAt: now }); break;
      case "turn_drained": this.updateTiming(sessionId, generation, { turnDrainedAt: now }); break;
      case "acp_terminal_sent": this.updateTiming(sessionId, generation, { acpTerminalSentAt: now }); break;
    }
  }

  increment(field: keyof Pick<BridgeMetricsSnapshot,
    "promptReceived" |
    "cosInputAcceptedOrReconciled" |
    "matchingTurnEndObserved" |
    "followUpsRegistered" |
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
    return { ...this.state, recentTurns: this.state.recentTurns.map((receipt) => ({ ...receipt })) };
  }
}
