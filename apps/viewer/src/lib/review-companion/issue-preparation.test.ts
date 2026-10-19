/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSavedIssue } from './issue-preparation';
test('preparation restores the chosen BCF concern and reuses its real evidence without another vision request', async () => {
  const calls: string[] = [];
  const result = await prepareSavedIssue({ workflow: {
    list: async () => [{ topicId: 'fascia', title: 'Saved corner step', findingId: 'observation', definitionRef: 'definition' }],
    investigate: async id => { calls.push(id); },
  }, onStatus: () => {} }, 'fascia', new AbortController().signal);
  assert.deepEqual(calls, ['fascia']);
  assert.deepEqual(result, { summary: 'Saved corner step', evidenceRefs: ['definition', 'observation'] });
});
test('cancellation prevents later work and missing topics never restore another concern', async () => {
  let restores = 0; const abort = new AbortController();
  const options = { workflow: { list: async () => [], investigate: async () => { restores++; } }, onStatus: () => {} };
  abort.abort(); await assert.rejects(prepareSavedIssue(options, 'missing', abort.signal), /abort/i);
  await assert.rejects(prepareSavedIssue(options, 'missing', new AbortController().signal), /not found/);
  assert.equal(restores, 0);
});
