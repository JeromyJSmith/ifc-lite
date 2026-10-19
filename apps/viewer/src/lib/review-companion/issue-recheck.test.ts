/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIssueWorkflow } from './issue-workflow';
import { recheckSavedConcern } from './issue-recheck';
import type { ReviewFinding } from './types';

function setup() {
  const context = { scopeId: 'source', models: [], elements: [], capturedAt: '2026-10-19T10:00:00Z', viewpoint: { guid: 'saved-view' } };
  const row = (id: string, value: unknown): ReviewFinding => ({ schemaVersion: 1, id, kind: 'note', text: JSON.stringify(value), context, createdAt: '2026-10-19T10:00:00Z' });
  const rows = [row('definition', { kind: 'review.bcf.definition', topicId: 'fascia', findingId: 'finding', title: 'Fascia step', description: 'Possible gap', createdAt: '2026-10-19T10:00:00Z' }), row('input', { kind: 'captured-view' }), row('response', { kind: 'model-response' })];
  let restores = 0;
  const workflow = createIssueWorkflow({ rows: async () => rows, persist: async value => { rows.push(value); return value.id; }, restore: async () => { restores++; }, verify: async () => {} });
  return { workflow, rows, restores: () => restores };
}

test('one direct inspection attaches real input/response to original BCF without restoring its camera', async () => {
  const s = setup(); let calls = 0;
  await recheckSavedConcern({ workflow: s.workflow, inspect: async input => {
    calls++; assert.equal(input.topicId, 'fascia'); assert.match(input.question, /current view/);
    return { summary: 'No visible open gap; board faces differ', evidenceRefs: ['input', 'response'] };
  } }, 'fascia');
  const issue = (await s.workflow.list())[0];
  assert.equal(calls, 1); assert.equal(s.restores(), 0);
  assert.equal(issue.stage, 'needs-evidence');
  assert.deepEqual(issue.evidenceRefs, ['input', 'response']);
  assert.match(issue.diagnosis, /No visible open gap/);
  assert.equal(s.rows.filter(row => row.text.includes('review.bcf.definition')).length, 1);
});

test('provider failure or missing persisted evidence cannot advance the issue', async () => {
  const s = setup();
  await assert.rejects(recheckSavedConcern({ workflow: s.workflow, inspect: async () => { throw new Error('Provider stopped'); } }, 'fascia'), /Provider stopped/);
  await assert.rejects(recheckSavedConcern({ workflow: s.workflow, inspect: async () => ({ summary: 'Looks fixed' }) }, 'fascia'), /persisted input/);
  assert.equal((await s.workflow.list())[0].stage, 'open');
});

test('a concurrent disposition survives an older visual inference', async () => {
  const s = setup();
  await assert.rejects(recheckSavedConcern({ workflow: s.workflow, inspect: async () => {
    await s.workflow.record({ topicId: 'fascia', stage: 'ready-to-fix', diagnosis: 'New native measurement', evidenceRefs: ['input'] });
    return { summary: 'Older image', evidenceRefs: ['input', 'response'] };
  } }, 'fascia'), /Issue changed/);
  assert.equal((await s.workflow.list())[0].stage, 'ready-to-fix');
});
