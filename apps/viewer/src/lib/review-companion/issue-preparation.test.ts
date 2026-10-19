/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSavedIssue, type IssuePreparationOptions } from './issue-preparation';
function setup(abort: AbortController, cancelAt?: string) {
  const events: string[] = [], instructions: string[] = [];
  const options: IssuePreparationOptions = {
    workflow: { list: async () => [{ topicId: 'issue', title: 'Discontinuous fascia corner' }], investigate: async id => { assert.equal(id, 'issue'); events.push('restore'); if (cancelAt === 'restore') abort.abort(); } },
    inspect: async (signal, instruction) => { signal.throwIfAborted(); events.push('visual'); instructions.push(instruction); if (cancelAt === 'visual') abort.abort(); return { summary: 'A step is visible at the corner; intent is unknown.', findings: [{ id: 'actual-observation' }] }; },
    onStatus: () => {},
  };
  return { options, events, instructions };
}
test('preparation restores one issue and asks one relevant visual question without bulk geometry reads', async () => {
  const abort = new AbortController(), s = setup(abort);
  const result = await prepareSavedIssue(s.options, 'issue', abort.signal);
  assert.deepEqual(s.events, ['restore', 'visual']);
  assert.match(s.instructions[0], /Discontinuous fascia corner/);
  assert.deepEqual(result, { summary: 'A step is visible at the corner; intent is unknown.', evidenceRefs: ['actual-observation'] });
  assert.equal('meshes' in result, false);
});
test('cancel after restoration prevents inspection', async () => {
  const abort = new AbortController(), s = setup(abort, 'restore');
  await assert.rejects(prepareSavedIssue(s.options, 'issue', abort.signal), /abort/i);
  assert.deepEqual(s.events, ['restore']);
});
test('cancellation during inspection preserves only completed actions; initial cancel prevents restoration', async () => {
  const abort = new AbortController(), s = setup(abort, 'visual');
  await assert.rejects(prepareSavedIssue(s.options, 'issue', abort.signal), /abort/i);
  assert.deepEqual(s.events, ['restore', 'visual']);
  const early = new AbortController(), before = setup(early); early.abort();
  await assert.rejects(prepareSavedIssue(before.options, 'issue', early.signal), /abort/i); assert.deepEqual(before.events, []);
});
