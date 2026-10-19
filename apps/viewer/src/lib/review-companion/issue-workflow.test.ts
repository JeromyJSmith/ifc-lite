/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIssueWorkflow, createIssueWorkflowTools, recordGeometryApplication, recordContactMeasurement, recordPointCorrespondence, saveIssueDiagnosis } from './issue-workflow';
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
const contact = { topicId: 'topic', expectedWorkflowRef: undefined, evidenceRef: 'contact', sourceHash: 'a'.repeat(64), pathA: 'roof', pathB: 'wall', contactCount: 0, distance: 0.0004, instanceA: 0, triangleA: 5 };
test('continuing an issue retains its diagnosis and evidence without restoring its original selection', async () => {
  const s = setup(); s.rows.push(s.row('measurement', { kind: 'native-measurement' }));
  await s.workflow.record({ topicId: 'topic', stage: 'needs-evidence', diagnosis: 'Door selected; frame it next', evidenceRefs: ['measurement'] });
  const original = structuredClone(s.rows);
  await s.workflow.continueInvestigation('topic');
  assert.deepEqual(s.restored, []);
  assert.deepEqual(s.rows.slice(0, original.length), original);
  const issue = (await s.workflow.list())[0];
  assert.equal(issue.diagnosis, 'Door selected; frame it next');
  assert.deepEqual(issue.evidenceRefs, ['definition', 'measurement']);
  await assert.rejects(s.workflow.continueInvestigation('missing'), /No saved/);
});
test('direct outcome edits preserve exact measured numbers, status, native evidence and the old record', async () => {
  const s = setup(); s.rows.push(s.row('measurement', { kind: 'native-measurement' }));
  const prior = await s.workflow.record({ topicId: 'topic', stage: 'needs-evidence', diagnosis: 'Incorrect level 3.008', evidenceRefs: ['measurement'] });
  const old = structuredClone(s.rows), text = 'Verified slab top 3.088; gap 0.007211043 → 0. Quantity recomputation remains pending.\nNo architectural acceptance claimed.';
  const saved = await saveIssueDiagnosis(s.workflow, { topicId: 'topic', expectedWorkflowRef: prior.workflowRef, diagnosis: text });
  assert.equal(saved.diagnosis, text); assert.equal(saved.stage, 'needs-evidence'); assert.deepEqual(saved.evidenceRefs, ['measurement']);
  assert.deepEqual(s.rows.slice(0, old.length), old); assert.equal((await s.workflow.list())[0].diagnosis, text);
});
test('a stale edit or failed persistence cannot overwrite a newer issue outcome', async () => {
  const s = setup();
  const old = await s.workflow.record({ topicId: 'topic', stage: 'needs-evidence', diagnosis: 'Earlier', evidenceRefs: [] });
  const current = await s.workflow.record({ topicId: 'topic', stage: 'ready-to-fix', diagnosis: 'Newer decision', evidenceRefs: [] });
  await assert.rejects(saveIssueDiagnosis(s.workflow, { topicId: 'topic', expectedWorkflowRef: old.workflowRef, diagnosis: 'Stale edit' }), /Issue changed/);
  s.fail(); await assert.rejects(saveIssueDiagnosis(s.workflow, { topicId: 'topic', expectedWorkflowRef: current.workflowRef, diagnosis: 'Unsaved edit' }), /disk unavailable/);
  assert.equal((await s.workflow.list())[0].diagnosis, 'Newer decision'); assert.equal((await s.workflow.list())[0].stage, 'ready-to-fix');
});
test('native contact facts persist directly, retain previous evidence, and never close the concern', async () => {
  const s = setup(); s.rows.push(s.row('contact', { kind: 'review.geometry.contact' }));
  await s.workflow.record({ topicId: 'topic', stage: 'needs-evidence', diagnosis: 'Prior evidence', evidenceRefs: ['contact'] });
  await s.workflow.investigate('topic');
  const issue = (await s.workflow.list())[0];
  assert.deepEqual(issue.evidenceRefs, ['definition', 'contact']);
  const saved = await recordContactMeasurement(s.workflow, { ...contact, expectedWorkflowRef: issue.workflowRef });
  assert.equal(saved.saved, true); assert.equal(saved.stage, 'needs-evidence');
  assert.match(saved.diagnosis, /0 contact clusters; nearest distance 0.0004/);
  assert.match(saved.diagnosis, /acceptance remain unverified/);
  assert.deepEqual(saved.evidenceRefs, ['contact', 'definition']); assert.equal(s.verified(), 0);
});
test('a newer issue disposition or persistence failure cannot become a successful native completion', async () => {
  const s = setup(); s.rows.push(s.row('contact', { kind: 'review.geometry.contact' }));
  await s.workflow.record({ topicId: 'topic', stage: 'ready-to-fix', diagnosis: 'Newer decision', evidenceRefs: ['contact'] });
  await assert.rejects(recordContactMeasurement(s.workflow, contact), /Issue changed/);
  const issue = (await s.workflow.list())[0]; assert.equal(issue.stage, 'ready-to-fix');
  s.fail();
  await assert.rejects(recordContactMeasurement(s.workflow, { ...contact, expectedWorkflowRef: issue.workflowRef }), /disk unavailable/);
  assert.equal((await s.workflow.list())[0].stage, 'ready-to-fix');
});
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
test('opening a fixed issue restores its view without changing its verified status or history', async () => {
  const s = setup();
  s.rows.push(s.row('mutation', { kind: 'native-mutation' }), s.row('after', { kind: 'native-verification' }));
  await s.workflow.record({ topicId: 'topic', stage: 'fixed', diagnosis: 'Measured repair', evidenceRefs: ['mutation', 'after'], mutationReceiptRef: 'mutation', verificationRef: 'after' });
  const before = structuredClone(s.rows);
  const opened = await s.workflow.open('topic');
  assert.equal(opened.stage, 'fixed'); assert.deepEqual(s.restored, ['finding']);
  assert.deepEqual(s.rows, before); assert.deepEqual(s.statuses, ['fixed']);
  assert.equal((await s.workflow.list())[0].verificationRef, 'after');
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

test('native geometry completion retains actual evidence and updates the issue without a model completion or false closure', async () => {
  const s = setup();
  s.rows.push(s.row('prior', { kind: 'prior-evidence' }), s.row('applied', { kind: 'review.geometry.applied' }), s.row('readback', { kind: 'review.geometry.verified' }));
  await s.workflow.record({ topicId: 'topic', stage: 'investigating', diagnosis: 'Inspecting old revision', evidenceRefs: ['prior'] });
  const original = structuredClone(s.rows[0]);
  s.rows.push(s.row('after-view', { kind: 'review.bcf.viewpoint' }));
  const saved = await recordGeometryApplication(s.workflow, { topicId: 'topic', operation: 'replace_mesh', receiptRef: 'applied', verificationRef: 'readback', sourceHash: 'new-source', sourceVerified: true, beforeFaces: 2415, afterFaces: 2417, diagnosis: 'Trimmed to room boundary', viewpointRef: 'after-view' });
  const issue = (await s.workflow.list())[0];
  assert.equal(saved.saved, true); assert.equal(issue.stage, 'needs-evidence');
  assert.deepEqual(issue.evidenceRefs, ['applied', 'readback', 'after-view', 'prior']);
  assert.match(issue.diagnosis, /Actual repaired image and camera are attached/);
  assert.match(issue.diagnosis, /2415 → 2417/); assert.match(issue.diagnosis, /new-source/);
  assert.equal(s.verified(), 0); assert.deepEqual(s.rows[0], original);
  s.fail();
  await assert.rejects(recordGeometryApplication(s.workflow, { topicId: 'topic', operation: 'replace_mesh', receiptRef: 'applied', verificationRef: 'readback', sourceHash: 'bad-source', sourceVerified: false, beforeFaces: 2415, afterFaces: 2417, diagnosis: 'Mismatch' }), /disk unavailable/);
  assert.match((await s.workflow.list())[0].diagnosis, /new-source/);
});

test('native projection receives the exact persisted event and never runs for a mismatched storage identity', async () => {
  const s = setup(), projected: ReviewFinding[] = [];
  let mismatch = false;
  const workflow = createIssueWorkflow({ rows: async () => s.rows, restore: async () => {}, verify: async () => {},
    persist: async row => { s.rows.push(structuredClone(row)); return mismatch ? 'different-id' : row.id; },
    onStatus: (_topic, _stage, row) => { assert.deepEqual(s.rows.at(-1), row); projected.push(row); } });
  const first = await workflow.record({ topicId: 'topic', stage: 'needs-evidence', diagnosis: 'Actual measured result', evidenceRefs: [] });
  assert.equal(projected[0].id, first.workflowRef);
  mismatch = true;
  await assert.rejects(workflow.record({ topicId: 'topic', stage: 'dismissed', diagnosis: 'Not projected', evidenceRefs: [] }), /different record identity/);
  assert.equal(projected.length, 1);
});

test('endpoint facts persist as measured evidence and cannot overwrite a newer disposition', async () => {
  const s = setup();
  const facts = { topicId: 'topic', expectedWorkflowRef: undefined, evidenceRef: 'endpoint-evidence', sourceHash: 'a'.repeat(64), distances: [0,0,0,0], entityNames: ['Board', 'Roof'] };
  s.rows.push(s.row('endpoint-evidence', { kind: 'review.geometry.correspondence' }));
  const result = await recordPointCorrespondence(s.workflow, facts);
  assert.equal(result.stage, 'needs-evidence');
  assert.match(result.diagnosis, /4 explicit point pairs; distances \[0, 0, 0, 0\]; maximum 0/);
  assert.ok(result.evidenceRefs.includes('endpoint-evidence'));
  await assert.rejects(recordPointCorrespondence(s.workflow, facts), /Issue changed/);
  const untouched = setup();
  await assert.rejects(recordPointCorrespondence(untouched.workflow, { ...facts, distances: [NaN] }), /Invalid native/);
  assert.equal((await untouched.workflow.list())[0].workflowRef, undefined);
});
