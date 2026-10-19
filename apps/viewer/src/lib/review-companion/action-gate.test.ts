/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewActionGate, runReviewAction, useReviewActionState, ReviewActionBusyError } from './action-gate';

test('review action stays busy through post-inference save and rejects a same-tick second action', async () => {
  const states: boolean[] = [], gate = createReviewActionGate(value => states.push(value));
  let finishSave!: () => void, secondCalls = 0;
  const saved = new Promise<void>(resolve => { finishSave = resolve; });
  const action = gate(async () => { await Promise.resolve(); await saved; return { workflowRef: 'actual-saved-outcome' }; });
  await assert.rejects(gate(async () => { secondCalls++; }), /current review action/);
  assert.equal(secondCalls, 0);
  assert.deepEqual(states, [true]);
  await Promise.resolve();
  assert.deepEqual(states, [true]);
  finishSave();
  assert.deepEqual(await action, { workflowRef: 'actual-saved-outcome' });
  assert.deepEqual(states, [true, false]);
  assert.equal(await gate(async () => 'next action'), 'next action');
  assert.deepEqual(states, [true, false, true, false]);
});

test('another panel consumer sees the same pending action and cannot start an overlapping save', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const first = runReviewAction(async () => { await pending; return 'saved'; });
  // A newly mounted panel reads the shared store, rather than resetting a
  // component-local busy flag while the old action is still in flight.
  assert.equal(useReviewActionState.getState().busy, true);
  await assert.rejects(runReviewAction(async () => 'must not run'), ReviewActionBusyError);
  assert.equal(useReviewActionState.getState().busy, true);
  finish();
  assert.equal(await first, 'saved');
  assert.equal(useReviewActionState.getState().busy, false);
});

test('failed persistence and cancellation release the gate and preserve the original error', async () => {
  for (const error of [new Error('BCF projection conflict; journal retained'), new DOMException('Stopped', 'AbortError')]) {
    const states: boolean[] = [], gate = createReviewActionGate(value => states.push(value));
    await assert.rejects(gate(async () => { throw error; }), actual => actual === error);
    assert.deepEqual(states, [true, false]);
    assert.equal(await gate(async () => 3.832499), 3.832499);
  }
});

test('a persistence failure remains visible to a remounted panel until a real retry starts', async () => {
  const failure = new Error('Saved diagnosis retained; native BCF comment conflicts');
  await assert.rejects(runReviewAction(async () => { throw failure; }), actual => actual === failure);
  assert.deepEqual(useReviewActionState.getState(), { busy: false, error: failure.message });
  await runReviewAction(async () => {
    assert.deepEqual(useReviewActionState.getState(), { busy: true, error: '' });
  });
  assert.deepEqual(useReviewActionState.getState(), { busy: false, error: '' });
  await assert.rejects(runReviewAction(async () => { throw new DOMException('Stopped', 'AbortError'); }), /Stopped/);
  assert.deepEqual(useReviewActionState.getState(), { busy: false, error: '' });
});
