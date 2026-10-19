/* global clearTimeout, setTimeout */

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asFiniteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a finite non-negative number`);
  return Number(value);
}

function eventOrder(event) {
  if (Number.isFinite(event?.position)) return Number(event.position);
  if (Number.isFinite(event?.seq)) return Number(event.seq);
  if (Number.isFinite(event?.time)) return Number(event.time);
  return Number.POSITIVE_INFINITY;
}

function assistantText(event) {
  const row = asObject(event?.message);
  return typeof row.text === "string" ? row.text : null;
}

function isToolLike(event) {
  return event?.kind === "tool_call" || event?.kind === "page_tool" || event?.kind === "agent_message";
}

export function directNoToolPrompt(expectedText) {
  if (typeof expectedText !== "string" || expectedText.length === 0) {
    throw new TypeError("expectedText must be a non-empty string");
  }
  return `Do not use tools. Reply exactly: ${expectedText}`;
}

export function directInputProof(sendRecordValue, { inputId, sessionId, inputDelivered }) {
  const sendRecord = asObject(sendRecordValue);
  return typeof inputId === "string"
    && typeof sessionId === "string"
    && sendRecord.id === inputId
    && sendRecord.sessionId === sessionId
    && (sendRecord.delivery === "pending" || sendRecord.delivery === "sent")
    && inputDelivered === true;
}

export function analyzeDirectTurn(events, { inputId, expectedText, endToEndMs }) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  const user = events.find((event) => event?.kind === "user_message" && event?.inputId === inputId);
  const start = user ? eventOrder(user) : Number.POSITIVE_INFINITY;
  const turnEnd = [...events].reverse().find((event) => event?.kind === "turn_end" && eventOrder(event) >= start);
  const final = [...events].reverse().find((event) =>
    event?.kind === "assistant_message" && event?.final === true && eventOrder(event) >= start,
  );
  const finalText = final ? assistantText(final) : null;
  const toolLikeCount = events.filter((event) => eventOrder(event) >= start && isToolLike(event)).length;
  return {
    inputDelivered: user?.inputDelivery === "confirmed",
    turnEndObserved: Boolean(turnEnd),
    turnId: typeof turnEnd?.turnId === "string" ? turnEnd.turnId : null,
    finalObserved: finalText !== null,
    finalMatched: finalText === expectedText,
    finalAssistantChars: finalText?.length ?? 0,
    toolLikeCount,
    endToEndMs: asFiniteNonNegative(endToEndMs, "endToEndMs"),
  };
}

export function analyzeProviderTurn(events, inputId) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  const user = events.find((event) =>
    event?.kind === "user_message" && event?.inputId === inputId && event?.inputDelivery === "confirmed",
  );
  if (!user) throw new Error("matching confirmed provider input is missing");
  const drain = [...events].reverse().find((event) => event?.kind === "turn_drained" && event?.inputId === inputId);
  if (!drain || typeof drain.turnId !== "string") throw new Error("matching provider turn drain is missing");
  if (drain.highWaterSeq !== drain.seq) throw new Error("provider drain high-water is invalid");
  const end = [...events].reverse().find((event) => event?.kind === "turn_end" && event?.turnId === drain.turnId);
  if (!end) throw new Error("matching provider turn_end is missing");
  if (!Number.isFinite(end.time) || !Number.isFinite(drain.time) || drain.time < end.time) {
    throw new Error("provider drain timing is invalid");
  }
  if (!Number.isInteger(drain.finalAssistantSeq) || drain.finalAssistantSeq < 1) {
    throw new Error("provider final assistant sequence is missing");
  }
  const final = events.find((event) =>
    event?.seq === drain.finalAssistantSeq && event?.kind === "assistant_message" && event?.final === true,
  );
  if (!final) throw new Error("provider final assistant event is missing");
  const start = eventOrder(user);
  const finish = eventOrder(drain);
  const toolLikeCount = events.filter((event) => {
    const order = eventOrder(event);
    return order >= start && order <= finish && isToolLike(event);
  }).length;
  return {
    turnId: drain.turnId,
    finalAssistantSeq: drain.finalAssistantSeq,
    nativeDrainMs: drain.time - end.time,
    toolLikeCount,
  };
}

export function slowConsumerPerformanceSample(metricsValue, drainedWithinMs) {
  const metrics = asObject(metricsValue);
  return {
    rssHighWaterBytes: asFiniteNonNegative(metrics.rssHighWaterBytes, "metrics.rssHighWaterBytes"),
    maxQueueDepth: asFiniteNonNegative(metrics.maxQueueDepth, "metrics.maxQueueDepth"),
    // Production stdio awaits each ACP notification write; it owns no intermediary output queue.
    queueCapacity: null,
    sseReconnectCount: asFiniteNonNegative(metrics.sseReconnectCount, "metrics.sseReconnectCount"),
    backoffCount: asFiniteNonNegative(metrics.backoffCount, "metrics.backoffCount"),
    controllerReadCount: asFiniteNonNegative(metrics.controllerReadCount, "metrics.controllerReadCount"),
    controllerActionCount: asFiniteNonNegative(metrics.controllerActionCount, "metrics.controllerActionCount"),
    drainedWithinMs: drainedWithinMs === null ? null : asFiniteNonNegative(drainedWithinMs, "drainedWithinMs"),
  };
}

export async function withHarnessTimeout(operation, { timeoutMs, onTimeout, message }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive finite number");
  if (typeof message !== "string" || message.length === 0) throw new TypeError("message must be a non-empty string");
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so a connection-close caused by cleanup cannot mask the timeout reason.
      reject(new Error(message));
      try {
        onTimeout?.();
      } catch {
        // Cleanup is secondary once the watchdog has fired.
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function evaluateDirectPairedEvidence(evidenceValue) {
  const evidence = asObject(evidenceValue);
  const samples = Array.isArray(evidence.samples) ? evidence.samples : [];
  const direct = Array.isArray(evidence.direct) ? evidence.direct : [];
  const browserBefore = asObject(evidence.browserBefore);
  const browserAfter = asObject(evidence.browserAfter);
  const healthy = (row) => row.connectionState === "connected" && row.bridgePaired === true && row.bridgePresent === true;
  const inputIds = samples.map((sample) => sample?.inputId).filter((value) => typeof value === "string");
  const sessionIds = samples.map((sample) => sample?.sessionId).filter((value) => typeof value === "string");
  const checks = {
    sampleCount: samples.length >= 10 && direct.length === samples.length,
    exactInputProof: samples.every((sample) => sample?.authoritativeInputProof === true)
      && inputIds.length === samples.length
      && sessionIds.length === samples.length
      && new Set(inputIds).size === samples.length
      && new Set(sessionIds).size === samples.length,
    everyTurnDelivered: samples.every((sample) => sample?.inputDelivered === true && sample?.turnEndObserved === true),
    everyFinalMatched: samples.every((sample) => sample?.finalObserved === true && sample?.finalMatched === true),
    noToolActivity: samples.every((sample) => sample?.toolLikeCount === 0),
    directShape: direct.every((sample) => Number.isFinite(sample?.endToEndMs) && sample.endToEndMs >= 0),
    browserBefore: healthy(browserBefore),
    browserAfter: healthy(browserAfter),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export function evaluateSlowConsumerEvidence(evidenceValue) {
  const evidence = asObject(evidenceValue);
  const slow = asObject(evidence.slowConsumer);
  const browserBefore = asObject(evidence.browserBefore);
  const browserAfter = asObject(evidence.browserAfter);
  const healthy = (row) => row.connectionState === "connected" && row.bridgePaired === true && row.bridgePresent === true;
  const minOutputChars = Number(evidence.minOutputChars);
  const checks = {
    terminal: evidence.stopReason === "end_turn",
    exactInputDelta: Number.isFinite(browserBefore.inputCount) && Number.isFinite(browserAfter.inputCount) &&
      browserAfter.inputCount - browserBefore.inputCount === 1,
    providerPolicy: evidence.policyEnforced === true,
    exactFinalContent: evidence.exactFinalContent === true,
    longOutput: Number.isFinite(minOutputChars) && minOutputChars > 4_000 &&
      Number.isFinite(evidence.assistantChars) && evidence.assistantChars >= minOutputChars,
    noToolActivity: evidence.toolLikeCount === 0 && evidence.projectedToolLikeCount === 0,
    drainDeadline: Number.isFinite(slow.drainedWithinMs) && slow.drainedWithinMs <= 30_000,
    rssHighWater: Number.isFinite(slow.rssHighWaterBytes) && slow.rssHighWaterBytes < 256 * 1024 * 1024,
    synchronousQueueBound: slow.queueCapacity === null && slow.maxQueueDepth === 0,
    reconnectBound: Number.isFinite(slow.sseReconnectCount) && Number.isFinite(slow.backoffCount) &&
      (slow.sseReconnectCount <= 1 || slow.backoffCount >= slow.sseReconnectCount - 1),
    browserBefore: healthy(browserBefore),
    browserAfter: healthy(browserAfter),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export function buildStep7PerformanceInput({ bridgedRows, directEvidence: directValue, slowEvidence: slowValue }) {
  if (!Array.isArray(bridgedRows)) throw new TypeError("bridgedRows must be an array");
  const bridged = bridgedRows.map((rowValue, index) => {
    const row = asObject(rowValue);
    if (row.eligibleNoTool !== true || row.exactFinal !== true) {
      throw new Error(`bridged row ${index + 1} is not an eligible exact no-tool turn`);
    }
    const sample = {
      preSendMs: asFiniteNonNegative(row.preSendMs, `bridged row ${index + 1}.preSendMs`),
      drainMs: asFiniteNonNegative(row.nativeDrainMs, `bridged row ${index + 1}.nativeDrainMs`),
      postDrainMs: asFiniteNonNegative(row.postDrainMs, `bridged row ${index + 1}.postDrainMs`),
    };
    if (row.t3DurationMs === undefined) return sample;
    return {
      ...sample,
      endToEndMs: asFiniteNonNegative(row.t3DurationMs, `bridged row ${index + 1}.t3DurationMs`),
    };
  });
  const directEvidence = asObject(directValue);
  if (asObject(directEvidence.evaluation).pass !== true) throw new Error("direct evidence did not pass its integrity checks");
  const direct = Array.isArray(directEvidence.direct) ? directEvidence.direct.map((sampleValue, index) => {
    const sample = asObject(sampleValue);
    return { endToEndMs: asFiniteNonNegative(sample.endToEndMs, `direct sample ${index + 1}.endToEndMs`) };
  }) : [];
  const slowEvidence = asObject(slowValue);
  if (asObject(slowEvidence.evaluation).pass !== true) throw new Error("slow-consumer evidence did not pass its integrity checks");
  const slowConsumer = asObject(slowEvidence.slowConsumer);
  return {
    bridged,
    direct,
    slowConsumer: slowConsumerPerformanceSample(slowConsumer, slowConsumer.drainedWithinMs ?? null),
  };
}
