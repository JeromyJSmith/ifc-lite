/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIssueWorkflow, createIssueWorkflowTools } from './issue-workflow';
import type { ReviewFinding } from './types';
function setup() {
  const context = { scopeId: 'original-source', models: [], elements: [], capturedAt: '2026-10-19T10:00:00Z', viewpoint: { guid: 'view', snapshot: 'original-image' } };
  const row = (id: string, text: unknown): ReviewFinding => ({ schemaVersion: 1, id, kind: 'note', text: JSON.stringify(text), context: structuredClone(context), createdAt: '2026-10-19T10:00:00Z' });
  const rows = [row('definition', { kind: 'review.bcf.definition', topicId: 'topic', findingId: 'finding', title: 'Visible opening', description: 'Check surrounding wall', createdAt: '2026-10-19T10:00:00Z' })];
  const restored: string[] = [], statuses: string[] = [];
  let rejectVerification = false, failPersist = false, verified = 0;
  const workflow = createIssueWorkflow({ rows: async () => structuredClone(rows), persist: async value => { if (failPersist) throw new Error('disk unavailable'); rows.push(structuredClone(value)); return value.id; },
    restore: async id => { restored.push(id); }, onStatus: async (_topic, stage) => { statuses.push(stage); },
    verify: async update => { verified++; if (rejectVerification || JSON.parse(rows.find(r => r.id === update.mutationReceiptRef)!.text).kind !== 'native-mutation') throw new Error('native verification rejected'); } });
  return { workflow, rows, restored, statuses, row, reject: () => { rejectVerification = true; }, fail: () => { failPersist = true; }, verified: () => verified };
}
test('investigation restores original context and appends durable state without rewriting evidence', async () => {
  const s = setup(), original = structuredClone(s.rows[0]);
  await s.workflow.investigate('topic');
  assert.deepEqual(s.restored, ['finding']); assert.deepEqual(s.statuses, ['investigating']); assert.deepEqual(s.rows[0], original);
  const [issue] = await s.workflow.list(); assert.equal(issue.stage, 'investigating'); assert.equal(issue.context.viewpoint.snapshot, 'original-image');
  assert.deepEqual(issue.evidenceRefs, ['definition']); assert.equal(s.rows[1].parentId, 'definition');
});
test('queue retains original scopes, sorts issues and selects latest event by time', async () => {
  const s = setup();
  s.rows.unshift(s.row('later-definition', { kind: 'review.bcf.definition', topicId: 'later', findingId: 'later-finding', title: 'Later', description: 'Description', createdAt: '2026-10-19T11:00:00Z' }));
  for (const [id, stage, time] of [['new', 'needs-evidence', '12'], ['old', 'investigating', '11']]) s.rows.push(s.row(id, { kind: 'review.bcf.workflow', topicId: 'topic', stage, diagnosis: id, evidenceRefs: [], createdAt: `2026-10-19T${time}:00:00Z` }));
  const queue = await s.workflow.list(); assert.deepEqual(queue.map(i => i.topicId), ['topic', 'later']); assert.equal(queue[0].scopeId, 'original-source'); assert.equal(queue[0].stage, 'needs-evidence');
});
test('fixed refuses invented refs, duplicate evidence and failed native verification', async () => {
  const s = setup(), update = { topicId: 'topic', stage: 'fixed' as const, diagnosis: 'Measured and closed opening', evidenceRefs: ['mutation', 'after'], mutationReceiptRef: 'mutation', verificationRef: 'after' };
  await assert.rejects(s.workflow.record(update), /has not been persisted/); assert.equal(s.verified(), 0);
  s.rows.push(s.row('mutation', { kind: 'native-mutation' }), s.row('after', { kind: 'native-verification' }));
  await assert.rejects(s.workflow.record({ ...update, verificationRef: 'mutation' }), /distinct/);
  await assert.rejects(s.workflow.record({ ...update, evidenceRefs: ['mutation'] }), /both mutation and verification/);
  s.reject(); await assert.rejects(s.workflow.record(update), /native verification rejected/);
  assert.equal((await s.workflow.list())[0].stage, 'open'); assert.deepEqual(s.statuses, []);
});
test('verified fix and reopen append history; failed persistence cannot change native status', async () => {
  const s = setup(); s.rows.push(s.row('mutation', { kind: 'native-mutation' }), s.row('after', { kind: 'native-verification' }));
  await s.workflow.record({ topicId: 'topic', stage: 'fixed', diagnosis: 'Measured and repaired opening', evidenceRefs: ['mutation', 'after'], mutationReceiptRef: 'mutation', verificationRef: 'after' });
  assert.equal(s.verified(), 1); assert.equal((await s.workflow.list())[0].stage, 'fixed');
  await s.workflow.record({ topicId: 'topic', stage: 'reopened', diagnosis: 'Adjacent opening needs inspection', evidenceRefs: ['after'] });
  assert.equal((await s.workflow.list())[0].stage, 'reopened'); assert.equal(s.rows.filter(r => r.text.includes('review.bcf.workflow')).length, 2);
  s.fail(); await assert.rejects(s.workflow.record({ topicId: 'topic', stage: 'dismissed', diagnosis: 'Dismiss', evidenceRefs: [] }), /disk unavailable/); assert.deepEqual(s.statuses, ['fixed', 'reopened']);
});
test('exposed tools restore actual saved issue and reject malformed evidence', async () => {
  const s = setup(), tools = createIssueWorkflowTools(s.workflow);
  await tools.find(t => t.name === 'review_investigate_issue')!.execute({ topicId: 'topic' }); assert.deepEqual(s.restored, ['finding']);
  await assert.rejects(tools.find(t => t.name === 'review_update_issue')!.execute({ topicId: 'topic', stage: 'needs-evidence', diagnosis: 'Measure fascia', evidenceRefsJson: '{}', mutationReceiptRef: '', verificationRef: '' }), /JSON array/);
  const result = await tools.find(t => t.name === 'review_issue_queue')!.execute({}) as Array<{ stage: string }>; assert.equal(result[0].stage, 'investigating');
});
test('fix tool includes supplied genuine receipt references without requiring a redundant evidence list', async () => {
  const s = setup();
  s.rows.push(s.row('mutation', { kind: 'native-mutation' }), s.row('after', { kind: 'native-verification' }));
  const tool = createIssueWorkflowTools(s.workflow).find(t => t.name === 'review_update_issue')!;
  await tool.execute({ topicId: 'topic', stage: 'fixed', diagnosis: 'Verified exact duplicate-face removal', evidenceRefsJson: '[]', mutationReceiptRef: 'mutation', verificationRef: 'after' });
  const issue = (await s.workflow.list())[0];
  assert.equal(issue.stage, 'fixed'); assert.equal(s.verified(), 1);
  assert.deepEqual(issue.evidenceRefs, ['mutation', 'after']); assert.deepEqual(s.statuses, ['fixed']);
});
test('automatic receipt evidence inclusion still refuses unknown refs and failed trusted native verification', async () => {
  const s = setup(), tool = createIssueWorkflowTools(s.workflow).find(t => t.name === 'review_update_issue')!;
  const input = { topicId: 'topic', stage: 'fixed', diagnosis: 'Claimed repair', evidenceRefsJson: '[]', mutationReceiptRef: 'mutation', verificationRef: 'after' };
  await assert.rejects(tool.execute(input), /has not been persisted/);
  assert.equal(s.verified(), 0); assert.equal((await s.workflow.list())[0].stage, 'open');
  s.rows.push(s.row('mutation', { kind: 'fabricated-agent-note' }), s.row('after', { kind: 'native-verification' }));
  await assert.rejects(tool.execute(input), /native verification rejected/);
  assert.equal(s.verified(), 1); assert.equal((await s.workflow.list())[0].stage, 'open'); assert.deepEqual(s.statuses, []);
});
