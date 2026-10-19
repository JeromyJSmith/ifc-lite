/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom';
import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createFastReviewTour, useFastReviewTour, type FastReviewTourState } from './useFastReviewTour';
import type { ReviewContext } from '@/lib/review-companion/types';

// Deterministic in-memory scheduling tests, not real model execution evidence.
function context(view: number): ReviewContext {
  return { scopeId: 'fixture:scope', models: [{ id: 'fixture:model', name: 'Fixture', sourceIdentity: 'fixture:source' }], elements: [],
    capturedAt: new Date().toISOString(), viewpoint: { guid: `fixture:view-${view}`, snapshot: `fixture:image-${view}` } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('camera continues while saved image analysis waits; backlog stays at two and inspection never overlaps', async () => {
  const gate = deferred<void>(), states: FastReviewTourState[] = [], inspected: string[] = [];
  let moves = 0, active = 0, maxActive = 0;
  const engine = createFastReviewTour({
    move: async step => { moves++; assert.equal(step, moves - 1); }, capture: async () => context(moves),
    inspect: async view => { active++; maxActive = Math.max(maxActive, active); inspected.push(view.viewpoint.guid); await gate.promise; active--; return { candidates: 0 }; },
  }, state => states.push(state));
  const run = engine.start(); await turn();
  assert.equal(moves, 240, 'slow inference does not stall the visible camera producer');
  assert.equal(engine.snapshot().length, 2, 'in-flight plus queued view is bounded');
  assert.deepEqual(inspected, ['fixture:view-1']);
  assert.equal(engine.state().pending, 2);
  assert.ok(states.some(state => state.status.includes('Live tour; analysing saved view 1 (1 waiting)')));
  assert.ok(states.every(state => state.pending <= 2));
  gate.resolve(); await run;
  assert.equal(maxActive, 1);
  assert.deepEqual(inspected, ['fixture:view-1', 'fixture:view-2']);
  assert.equal(engine.state().completed, 2); assert.equal(engine.state().running, false);
  assert.equal(engine.state().outcome, 'completed');
});

test('fast analysis consumes at most twelve frozen captures and retained context cannot be mutated by a consumer', async () => {
  let moves = 0, inspections = 0;
  const engine = createFastReviewTour({ move: async () => { moves++; }, capture: async () => context(moves),
    inspect: async captured => { inspections++; captured.viewpoint.guid = 'consumer-mutated-copy'; return { candidates: 0 }; } });
  await engine.start();
  assert.equal(engine.snapshot().length, 12); assert.equal(inspections, 12); assert.equal(moves, 12);
  assert.deepEqual(engine.snapshot().map(entry => entry.context.viewpoint.guid), Array.from({ length: 12 }, (_, index) => `fixture:view-${index + 1}`));
  assert.ok(engine.snapshot().every(entry => entry.status === 'completed'));
  const external = engine.snapshot(); external[0].context.viewpoint.guid = 'external-mutation';
  assert.equal(engine.snapshot()[0].context.viewpoint.guid, 'fixture:view-1');
});

test('five actual candidates stop new camera steps and captures without inventing a quota of findings', async () => {
  let moves = 0;
  const engine = createFastReviewTour({ move: async () => { moves++; }, capture: async () => context(moves), inspect: async () => ({ candidates: 5 }) });
  await engine.start();
  assert.ok(moves <= 2); assert.ok(engine.snapshot().length <= 2);
  assert.equal(engine.snapshot()[0].result?.candidates, 5);
  assert.match(engine.state().status, /candidate findings/);
});

test('explicit stop aborts motion and image analysis, preserves captures, and never resumes automatically', async () => {
  let moves = 0, inspections = 0;
  const signals: AbortSignal[] = [];
  const cancelled = (signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true });
  });
  const engine = createFastReviewTour({
    move: async (_step, signal) => { signals.push(signal); moves++; if (moves === 3) await cancelled(signal); },
    capture: async () => context(moves), inspect: async (_context, signal) => { signals.push(signal); inspections++; await cancelled(signal); return { candidates: 0 }; },
  });
  const run = engine.start(); await turn(); engine.stop(); await run;
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(engine.state().running, false); assert.equal(engine.state().pending, 0);
  assert.equal(engine.state().outcome, 'interrupted');
  assert.equal(engine.snapshot().length, 2); assert.ok(engine.snapshot().every(entry => entry.status === 'interrupted'));
  await turn(); assert.equal(moves, 3); assert.equal(inspections, 1);
});

test('a capture already being persisted at Stop remains retained but is never analysed afterwards', async () => {
  const saved = deferred<ReviewContext>(); let inspections = 0;
  const engine = createFastReviewTour({ move: async () => {}, capture: () => saved.promise,
    inspect: async () => { inspections++; return { candidates: 0 }; } });
  const run = engine.start(); await turn(); engine.stop(); saved.resolve(context(1)); await run;
  assert.equal(engine.snapshot().length, 1); assert.equal(engine.snapshot()[0].status, 'interrupted');
  assert.equal(inspections, 0);
});

test('analysis failure stops motion and reports the actual error without marking that capture completed', async () => {
  let moves = 0;
  const engine = createFastReviewTour({ move: async () => { moves++; }, capture: async () => context(moves),
    inspect: async () => { throw new Error('vision projector unavailable'); } });
  await engine.start();
  assert.equal(engine.state().completed, 0); assert.match(engine.state().status, /vision projector unavailable/);
  assert.equal(engine.state().outcome, 'failed');
  assert.equal(engine.snapshot()[0].status, 'failed');
  assert.ok(moves <= 2);
});

test('finite motion budgets and duplicate Start calls cannot create an overlapping producer', async () => {
  const gate = deferred<void>(); let moves = 0;
  const engine = createFastReviewTour({ maxMoves: 3, move: async () => { moves++; }, capture: async () => context(moves), inspect: async () => { await gate.promise; return { candidates: 0 }; } });
  const first = engine.start(), second = engine.start(); assert.equal(first, second);
  await turn(); assert.equal(moves, 3); gate.resolve(); await first;
  for (const maxMoves of [0, 361, NaN, 1.5]) assert.throws(() => createFastReviewTour({ maxMoves, move: async () => {}, capture: async () => context(1), inspect: async () => ({ candidates: 0 }) }), /move budget/);
});

test('a retained Start callback refuses after the review panel hides or unmounts; getState stays current and stable', async () => {
  let latest!: ReturnType<typeof useFastReviewTour>, moves = 0;
  function Harness({ active }: { active: boolean }) {
    latest = useFastReviewTour({ active, move: async () => { moves++; }, capture: async () => context(moves), inspect: async () => ({ candidates: 0 }) });
    return null;
  }
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Harness, { active: true })));
  const retainedStart = latest.start, getState = latest.getState;
  assert.equal(getState().outcome, null);
  await act(async () => root.render(createElement(Harness, { active: false })));
  assert.equal(latest.getState, getState);
  await assert.rejects(retainedStart(), { name: 'AbortError' });
  await act(async () => root.render(createElement(Harness, { active: true })));
  const retainedAfterUnmount = latest.start;
  await act(async () => root.unmount());
  await assert.rejects(retainedAfterUnmount(), { name: 'AbortError' });
  assert.equal(moves, 0, 'asynchronous setup cannot launch a ghost camera tour');
  container.remove();
});
