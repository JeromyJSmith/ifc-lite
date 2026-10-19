/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSavedIssue, createIssuePreparationSession, runIssuePreparation } from './issue-preparation';
test('preparation restores the chosen BCF concern and reuses its real evidence without another vision request', async () => {
  const calls: string[] = [];
  const result = await prepareSavedIssue({ workflow: {
    list: async () => [{ topicId: 'fascia', title: 'Saved corner step', findingId: 'observation', definitionRef: 'definition' }],
    investigate: async id => { calls.push(id); },
  }, onStatus: () => {} }, 'fascia', new AbortController().signal);
  assert.deepEqual(calls, ['fascia']);
  assert.deepEqual(result, { summary: 'Saved corner step', evidenceRefs: ['definition', 'observation'], viewMode: 'restored' });
});

test('consecutive steps retain the working door selection; issue, source, edits and explicit restore invalidate continuation', async () => {
  const session = createIssuePreparationSession();
  let revision = { models: {}, mutationVersion: 0, geometryUpdateTick: 0 }, selected = 'walls';
  const calls: string[] = [];
  const options = { session, state: () => revision, running: false, controller: { current: null as AbortController | null },
    onBusy: () => {}, onPause: () => {}, onStatus: () => {}, workflow: {
      list: async () => ['window', 'other'].map(topicId => ({ topicId, title: topicId, findingId: 'finding', definitionRef: 'definition' })),
      investigate: async () => { calls.push('restore'); selected = 'walls'; },
      continueInvestigation: async () => { calls.push('continue'); },
    } };
  assert.equal((await runIssuePreparation(options, 'window')).viewMode, 'restored');
  selected = 'door';
  assert.equal((await runIssuePreparation(options, 'window')).viewMode, 'continued');
  assert.equal(selected, 'door');
  for (const change of [() => { revision = { ...revision, models: {} }; },
    () => { revision = { ...revision, mutationVersion: 1 }; },
    () => { revision = { ...revision, geometryUpdateTick: 1 }; }, () => session.reset()]) {
    change(); selected = 'door';
    assert.equal((await runIssuePreparation(options, 'window')).viewMode, 'restored');
    assert.equal(selected, 'walls');
  }
  assert.equal((await runIssuePreparation(options, 'other')).viewMode, 'restored');
  assert.deepEqual(calls, ['restore', 'continue', 'restore', 'restore', 'restore', 'restore', 'restore']);
});

test('model replacement during preparation refuses a mixed revision and clears continuation', async () => {
  const session = createIssuePreparationSession();
  let revision = { models: {}, mutationVersion: 0, geometryUpdateTick: 0 };
  const options = { session, state: () => revision, running: false, controller: { current: null as AbortController | null },
    onBusy: () => {}, onPause: () => {}, onStatus: () => {}, workflow: {
      list: async () => [{ topicId: 'window', title: 'window', findingId: 'finding', definitionRef: 'definition' }],
      investigate: async () => { revision = { ...revision, models: {} }; },
    } };
  await assert.rejects(runIssuePreparation(options, 'window'), /model changed/);
  assert.equal(session.canContinue('window', revision), false);
  assert.equal(options.controller.current, null);
});
test('cancellation prevents later work and missing topics never restore another concern', async () => {
  let restores = 0; const abort = new AbortController();
  const options = { workflow: { list: async () => [], investigate: async () => { restores++; } }, onStatus: () => {} };
  abort.abort(); await assert.rejects(prepareSavedIssue(options, 'missing', abort.signal), /abort/i);
  await assert.rejects(prepareSavedIssue(options, 'missing', new AbortController().signal), /not found/);
  assert.equal(restores, 0);
});
