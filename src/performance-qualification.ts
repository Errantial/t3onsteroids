export interface BridgedTurnSample {
  readonly preSendMs: number;
  readonly drainMs: number;
  readonly postDrainMs: number;
  readonly endToEndMs?: number;
}

export interface DirectTurnSample {
  readonly endToEndMs: number;
}

export interface SlowConsumerSample {
  readonly rssHighWaterBytes: number;
  readonly maxQueueDepth: number;
  readonly queueCapacity: number;
  readonly sseReconnectCount: number;
  readonly backoffCount: number;
  readonly controllerReadCount: number;
  readonly controllerActionCount: number;
  readonly drainedWithinMs: number | null;
}

export interface Step7PerformanceInput {
  readonly bridged: readonly BridgedTurnSample[];
  readonly direct: readonly DirectTurnSample[];
  readonly slowConsumer: SlowConsumerSample;
}

export interface Step7PerformanceResult {
  readonly pass: boolean;
  readonly bridgedCount: number;
  readonly directCount: number;
  readonly preSendP95Ms: number | null;
  readonly drainP95Ms: number | null;
  readonly postDrainP95Ms: number | null;
  readonly bridgedMedianEndToEndMs: number | null;
  readonly bridgedP95EndToEndMs: number | null;
  readonly directMedianEndToEndMs: number | null;
  readonly directP95EndToEndMs: number | null;
  readonly checks: Readonly<Record<string, boolean>>;
}

const MIB = 1024 * 1024;

function finiteNonNegative(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value) && value >= 0);
}

export function nearestRankPercentile(values: readonly number[], percentile: number): number | null {
  const samples = finiteNonNegative(values).sort((a, b) => a - b);
  if (samples.length === 0) return null;
  if (!(percentile > 0 && percentile <= 1)) throw new RangeError("percentile must be in (0, 1]");
  const index = Math.ceil(percentile * samples.length) - 1;
  return samples[index]!;
}

export function median(values: readonly number[]): number | null {
  const samples = finiteNonNegative(values).sort((a, b) => a - b);
  if (samples.length === 0) return null;
  const middle = Math.floor(samples.length / 2);
  return samples.length % 2 === 1
    ? samples[middle]!
    : (samples[middle - 1]! + samples[middle]!) / 2;
}

export function qualifyStep7Performance(input: Step7PerformanceInput): Step7PerformanceResult {
  const preSendP95Ms = nearestRankPercentile(input.bridged.map((sample) => sample.preSendMs), 0.95);
  const drainP95Ms = nearestRankPercentile(input.bridged.map((sample) => sample.drainMs), 0.95);
  const postDrainP95Ms = nearestRankPercentile(input.bridged.map((sample) => sample.postDrainMs), 0.95);
  const bridgedEndToEnd = input.bridged.flatMap((sample) => sample.endToEndMs === undefined ? [] : [sample.endToEndMs]);
  const directEndToEnd = input.direct.map((sample) => sample.endToEndMs);

  const checks = {
    bridgedSampleCount: input.bridged.length >= 10,
    directSampleCount: input.direct.length >= 10,
    preSendP95: preSendP95Ms !== null && preSendP95Ms <= 250,
    drainP95: drainP95Ms !== null && drainP95Ms <= 1_000,
    postDrainP95: postDrainP95Ms !== null && postDrainP95Ms <= 250,
    drainDeadline: input.slowConsumer.drainedWithinMs !== null && input.slowConsumer.drainedWithinMs <= 30_000,
    rssHighWater: input.slowConsumer.rssHighWaterBytes < 256 * MIB,
    queueBound: input.slowConsumer.maxQueueDepth <= input.slowConsumer.queueCapacity,
    reconnectBound: input.slowConsumer.sseReconnectCount <= 1 || input.slowConsumer.backoffCount >= input.slowConsumer.sseReconnectCount - 1,
  } as const;

  return {
    pass: Object.values(checks).every(Boolean),
    bridgedCount: input.bridged.length,
    directCount: input.direct.length,
    preSendP95Ms,
    drainP95Ms,
    postDrainP95Ms,
    bridgedMedianEndToEndMs: median(bridgedEndToEnd),
    bridgedP95EndToEndMs: nearestRankPercentile(bridgedEndToEnd, 0.95),
    directMedianEndToEndMs: median(directEndToEnd),
    directP95EndToEndMs: nearestRankPercentile(directEndToEnd, 0.95),
    checks,
  };
}
