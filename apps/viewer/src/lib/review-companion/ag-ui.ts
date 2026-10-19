/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Local event journal using the AG-UI documented wire shapes, read 2026-10-19:
 * https://docs.ag-ui.com/concepts/events
 * https://docs.ag-ui.com/sdk/js/core/events
 * This is a wire-format adapter, not an AG-UI server or SDK implementation.
 */
type Base = { timestamp: number };
type EventPayload = (
  | { type: 'RUN_STARTED' | 'RUN_FINISHED'; threadId: string; runId: string }
  | { type: 'RUN_ERROR'; message: string }
  | { type: 'STATE_SNAPSHOT'; snapshot: unknown }
  | { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string }
  | { type: 'TOOL_CALL_END'; toolCallId: string }
  | { type: 'TOOL_CALL_RESULT'; messageId: string; toolCallId: string; content: string; role: 'tool' }
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string }
);
export type ReviewAgUiEvent = Base & EventPayload;

function identifier(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('AG-UI identifiers must be nonempty bounded text');
  }
}
function json(value: unknown): string {
  const result = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error('AG-UI payload contains a nonfinite number');
    if (typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') throw new Error('AG-UI payload must be JSON data');
    return entry;
  });
  if (result === undefined || result.length > 2_000_000) throw new Error('AG-UI payload is missing or exceeds its limit');
  return result;
}

/** An SSE data frame; the caller owns transport, MIME headers and persistence. */
export function encodeReviewEventSse(event: ReviewAgUiEvent): string {
  return `data: ${json(event)}\n\n`;
}

export function createReviewEventStream(options: {
  threadId: string;
  runId: string;
  onEvent(event: ReviewAgUiEvent): void | Promise<void>;
}) {
  identifier(options.threadId); identifier(options.runId);
  let phase: 'idle' | 'running' | 'terminal' = 'idle';
  const calls = new Map<string, 'arguments-ended' | 'result'>();
  const journal: ReviewAgUiEvent[] = [];
  let deliveryFailure: Error | null = null;
  let tail = Promise.resolve();
  // Serialize calls even when a producer forgets to await an earlier one.
  // Each returned operation still rejects; the scheduling tail alone recovers
  // from validation errors so the producer can emit an honest RUN_ERROR.
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const operation = tail.then(async () => {
      if (deliveryFailure) throw deliveryFailure;
      return run();
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  function running() {
    if (phase !== 'running') throw new Error('AG-UI run has not started or is already terminal');
  }
  async function emit(payload: EventPayload) {
    const event = { ...payload, timestamp: Date.now() } as ReviewAgUiEvent;
    // The local journal records emission attempts, not a claim of durable save.
    // Keep an attempted event even if the sink rejects; never invent a success.
    journal.push(event);
    try { await options.onEvent(structuredClone(event)); }
    catch (error) {
      deliveryFailure = error instanceof Error ? error : new Error(String(error));
      throw deliveryFailure;
    }
  }
  function start() {
    return enqueue(async () => {
      if (phase !== 'idle') throw new Error('AG-UI run can only start once');
      phase = 'running';
      await emit({ type: 'RUN_STARTED', threadId: options.threadId, runId: options.runId });
    });
  }
  function state(snapshot: unknown) {
    return enqueue(async () => { running(); await emit({ type: 'STATE_SNAPSHOT', snapshot: JSON.parse(json(snapshot)) }); });
  }
  function toolStart(id: string, name: string, args: unknown) {
    return enqueue(async () => {
      running(); identifier(id); identifier(name);
      if (calls.has(id)) throw new Error('AG-UI tool call ID was already used');
      const delta = json(args);
      calls.set(id, 'arguments-ended');
      await emit({ type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name });
      await emit({ type: 'TOOL_CALL_ARGS', toolCallId: id, delta });
      // END means arguments are complete. It is not an execution success event.
      await emit({ type: 'TOOL_CALL_END', toolCallId: id });
    });
  }
  function toolResult(id: string, result: unknown) {
    return enqueue(async () => {
      running(); identifier(id);
      if (calls.get(id) !== 'arguments-ended') throw new Error('AG-UI tool result has no unfinished matching call');
      const content = json(result);
      calls.set(id, 'result');
      // The executor calls this only after the real tool settles, including an
      // actual error result. This adapter never executes or guesses a result.
      await emit({ type: 'TOOL_CALL_RESULT', messageId: crypto.randomUUID(), toolCallId: id, role: 'tool', content });
    });
  }
  function text(message: string) {
    return enqueue(async () => {
      running();
      if (typeof message !== 'string' || !message.length || message.length > 50000) throw new Error('AG-UI text message must be nonempty bounded text');
      const messageId = crypto.randomUUID();
      await emit({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
      await emit({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: message });
      await emit({ type: 'TEXT_MESSAGE_END', messageId });
      return messageId;
    });
  }
  function finish() {
    return enqueue(async () => {
      running();
      if ([...calls.values()].some(status => status !== 'result')) throw new Error('AG-UI run cannot finish while tool results are missing');
      phase = 'terminal';
      await emit({ type: 'RUN_FINISHED', threadId: options.threadId, runId: options.runId });
    });
  }
  function error(error: unknown) {
    return enqueue(async () => {
      running();
      const message = error instanceof Error ? error.message : String(error);
      if (!message || message.length > 50000) throw new Error('AG-UI error must have a nonempty bounded message');
      phase = 'terminal';
      await emit({ type: 'RUN_ERROR', message });
    });
  }
  return { start, state, toolStart, toolResult, text, finish, error,
    /** Detached local emission journal. Sink completion remains the caller's responsibility. */
    events: () => structuredClone(journal) };
}
