/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewEventStream, encodeReviewEventSse, type ReviewAgUiEvent } from './ag-ui';

test('wire events preserve actual tool ordering and IDs; END closes arguments before a later execution result', async () => {
  const events: ReviewAgUiEvent[] = [];
  const stream = createReviewEventStream({ threadId: 'review-thread', runId: 'run-one', onEvent: event => { events.push(event); } });
  const startTime = Date.now();
  await stream.start(); await stream.state({ mode: 'observe' });
  await stream.toolStart('native-call', 'viewer_select_element', { modelId: 'A', expressId: 42 });
  assert.deepEqual(events.map(event => event.type), ['RUN_STARTED', 'STATE_SNAPSHOT', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END']);
  assert.equal(events.some(event => event.type === 'TOOL_CALL_RESULT'), false, 'argument completion does not fabricate execution success');
  const actualResult = { selected: { modelId: 'A', expressId: 42 }, success: true };
  await stream.toolResult('native-call', actualResult);
  const messageId = await stream.text('Selected the exact native element.');
  await stream.finish();
  assert.deepEqual(events.map(event => event.type), ['RUN_STARTED', 'STATE_SNAPSHOT', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
  const start = events[0], args = events[3], result = events[5], end = events.at(-1)!;
  assert.ok(start.type === 'RUN_STARTED'); assert.equal(start.threadId, 'review-thread'); assert.equal(start.runId, 'run-one');
  assert.ok(args.type === 'TOOL_CALL_ARGS'); assert.equal(args.toolCallId, 'native-call'); assert.deepEqual(JSON.parse(args.delta), { modelId: 'A', expressId: 42 });
  assert.ok(result.type === 'TOOL_CALL_RESULT'); assert.equal(result.toolCallId, 'native-call'); assert.equal(result.role, 'tool'); assert.deepEqual(JSON.parse(result.content), actualResult);
  for (const event of events.slice(6, 9)) { assert.ok('messageId' in event); assert.equal(event.messageId, messageId); }
  assert.ok(end.type === 'RUN_FINISHED'); assert.equal(end.runId, 'run-one');
  assert.ok(events.every(event => Number.isInteger(event.timestamp) && event.timestamp >= startTime && event.timestamp <= Date.now()));
});

test('awaited event sink applies backpressure and concurrent method calls cannot overtake run start', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delivered: string[] = [];
  const stream = createReviewEventStream({ threadId: 't', runId: 'r', onEvent: async event => {
    delivered.push(event.type); if (event.type === 'RUN_STARTED') await gate;
  } });
  let startSettled = false;
  const started = stream.start().then(() => { startSettled = true; });
  const snapshot = stream.state({ ready: true });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(delivered, ['RUN_STARTED']); assert.equal(startSettled, false);
  release!(); await started; await snapshot; await stream.finish();
  assert.deepEqual(delivered, ['RUN_STARTED', 'STATE_SNAPSHOT', 'RUN_FINISHED']);
});

test('duplicate calls, orphan results and success with unfinished tools are refused; an honest error may terminate', async () => {
  const stream = createReviewEventStream({ threadId: 't', runId: 'r', onEvent: () => {} });
  await assert.rejects(stream.state({}), /not started/);
  await stream.start();
  await assert.rejects(stream.start(), /only start once/);
  await assert.rejects(stream.toolResult('missing', { ok: true }), /no unfinished matching call/);
  await stream.toolStart('one', 'inspect', {});
  await assert.rejects(stream.toolStart('one', 'inspect', {}), /already used/);
  await assert.rejects(stream.finish(), /results are missing/);
  await stream.error(new Error('Tool execution failed before it could return a result'));
  assert.equal(stream.events().at(-1)?.type, 'RUN_ERROR');
  assert.equal(stream.events().some(event => event.type === 'TOOL_CALL_RESULT'), false);
  await assert.rejects(stream.finish(), /already terminal/);
  await assert.rejects(stream.error('second terminal'), /already terminal/);
  await assert.rejects(stream.text('late message'), /already terminal/);
});

test('one result per call and one terminal event per run', async () => {
  const stream = createReviewEventStream({ threadId: 't', runId: 'r', onEvent: () => {} });
  await stream.start(); await stream.toolStart('one', 'inspect', {}); await stream.toolResult('one', { error: 'native refusal' });
  await assert.rejects(stream.toolResult('one', { success: true }), /no unfinished matching call/);
  await stream.finish();
  await assert.rejects(stream.finish(), /already terminal/);
  assert.equal(stream.events().filter(event => ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type)).length, 1);
});

test('sink failure is surfaced, retained as attempted evidence and cannot be followed by a fabricated success', async () => {
  const stream = createReviewEventStream({ threadId: 't', runId: 'r', onEvent: event => {
    if (event.type === 'TOOL_CALL_RESULT') throw new Error('persistent journal refused');
  } });
  await stream.start(); await stream.toolStart('one', 'inspect', {});
  await assert.rejects(stream.toolResult('one', { actual: 'completed action' }), /persistent journal refused/);
  await assert.rejects(stream.finish(), /persistent journal refused/);
  assert.equal(stream.events().at(-1)?.type, 'TOOL_CALL_RESULT');
  assert.equal(stream.events().some(event => event.type === 'RUN_FINISHED'), false);
});

test('state and journal are detached from caller and callback mutations; SSE preserves multiline JSON safely', async () => {
  const state = { selected: { expressId: 42 }, note: 'line one\nline two' };
  const stream = createReviewEventStream({ threadId: 't', runId: 'r', onEvent: event => {
    if (event.type === 'STATE_SNAPSHOT') (event.snapshot as { selected: { expressId: number } }).selected.expressId = 999;
  } });
  await stream.start(); await stream.state(state); state.selected.expressId = 777;
  const saved = stream.events().find(event => event.type === 'STATE_SNAPSHOT');
  assert.ok(saved?.type === 'STATE_SNAPSHOT');
  assert.deepEqual(saved.snapshot, { selected: { expressId: 42 }, note: 'line one\nline two' });
  const frame = encodeReviewEventSse(saved);
  assert.equal(frame.split('\n').length, 3);
  assert.ok(frame.startsWith('data: ')); assert.ok(frame.endsWith('\n\n'));
  assert.deepEqual(JSON.parse(frame.slice(6).trim()), saved);
  (saved.snapshot as { selected: { expressId: number } }).selected.expressId = 888;
  const untouched = stream.events().find(event => event.type === 'STATE_SNAPSHOT');
  assert.ok(untouched?.type === 'STATE_SNAPSHOT');
  assert.equal((untouched.snapshot as { selected: { expressId: number } }).selected.expressId, 42);
});

test('invalid JSON payload and empty text create no misleading partial call or message events', async () => {
  const stream = createReviewEventStream({ threadId: 't', runId: 'r', onEvent: () => {} });
  await stream.start();
  await assert.rejects(stream.toolStart('one', 'inspect', { coordinate: Infinity }), /nonfinite/);
  await assert.rejects(stream.text(''), /nonempty/);
  await assert.rejects(stream.state(undefined), /missing/);
  assert.deepEqual(stream.events().map(event => event.type), ['RUN_STARTED']);
  await stream.error('Payload was invalid');
});
