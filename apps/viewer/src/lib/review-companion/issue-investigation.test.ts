/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIssueWorkflow } from './issue-workflow';
import { investigateSavedIssue } from './issue-investigation';
import type { ReviewFinding } from './types';
function setup() {
  const context = { scopeId: 'source', models: [], elements: [], capturedAt: '2026-10-19T10:00:00Z', viewpoint: { guid: 'original-view' } };
  const row = (id: string, value: unknown): ReviewFinding => ({ schemaVersion: 1, id, kind: 'note', text: JSON.stringify(value), context, createdAt: '2026-10-19T10:00:00Z' });
  const rows = [row('definition', { kind: 'review.bcf.definition', topicId: 'fascia', findingId: 'finding', title: 'Stepped fascia', description: 'A gap at the corner', createdAt: '2026-10-19T10:00:00Z' }), row('measurement', { kind: 'native-measurement' })];
  const workflow = createIssueWorkflow({ rows: async () => rows, persist: async r => { rows.push(r); return r.id; }, restore: async () => {}, verify: async () => {} });
  const prepare = async () => { await workflow.investigate('fascia'); return { summary: 'A corner step is visible; its intent is unknown.', evidenceRefs: ['measurement'] }; };
  return { workflow, rows, row, prepare };
}
test('the selected original concern and diagnosis reach Bonsai and its precise blocker persists', async () => {
  const s = setup();
  await s.workflow.record({ topicId: 'fascia', stage: 'needs-evidence', diagnosis: 'Need corner section', evidenceRefs: ['measurement'] });
  const result = await investigateSavedIssue({ workflow: s.workflow, prepare: s.prepare, ask: async (directive, evidence) => {
    assert.ok(directive.length < 8000);
    const issue = (evidence as { issue: { topicId: string; description: string; priorDiagnosis: string } }).issue;
    assert.equal(issue.topicId, 'fascia'); assert.equal(issue.description, 'A gap at the corner'); assert.equal(issue.priorDiagnosis, 'Need corner section');
    await s.workflow.record({ topicId: 'fascia', stage: 'needs-evidence', diagnosis: 'Corner return thickness is not measured', evidenceRefs: ['measurement'] });
    return { text: 'Measure the corner return.' };
  } }, 'fascia');
  assert.equal(result.stage, 'needs-evidence'); assert.equal(result.diagnosis, 'Corner return thickness is not measured');
});
test('the request contains only the chosen BCF concern and one observation, not the other issues or geometry', async () => {
  const s = setup();
  s.rows.push(s.row('other', { kind: 'review.bcf.definition', topicId: 'other', findingId: 'other-finding', title: 'UNRELATED_ISSUE', description: 'UNRELATED_EVIDENCE'.repeat(1000), createdAt: '2026-10-19T10:00:00Z' }));
  await investigateSavedIssue({ workflow: s.workflow, prepare: s.prepare, ask: async (_directive, evidence) => {
    const data = evidence as { issue: { topicId: string }; savedObservation: unknown };
    assert.equal(data.issue.topicId, 'fascia'); assert.deepEqual(data.savedObservation, { summary: 'A corner step is visible; its intent is unknown.', evidenceRefs: ['measurement'] });
    const wire = JSON.stringify(data); assert.ok(wire.length < 1500); assert.equal(wire.includes('UNRELATED'), false); assert.equal('geometry' in data, false);
    return { text: 'Need the corner return measurement.' };
  } }, 'fascia');
});
test('fixing another issue cannot silently complete the original concern', async () => {
  const s = setup();
  s.rows.push(s.row('mesh-definition', { kind: 'review.bcf.definition', topicId: 'mesh', findingId: 'mesh-finding', title: 'Mesh integrity: duplicate faces', description: 'Nearby ceiling mesh', createdAt: '2026-10-19T10:00:00Z' }), s.row('mutation', {}), s.row('verification', {}));
  const result = await investigateSavedIssue({ workflow: s.workflow, prepare: s.prepare, ask: async () => {
    await s.workflow.record({ topicId: 'mesh', stage: 'fixed', diagnosis: 'Removed duplicate mesh faces', evidenceRefs: ['mutation', 'verification'], mutationReceiptRef: 'mutation', verificationRef: 'verification' });
    return { text: 'Nearby mesh cleaned; fascia still requires dimensions.' };
  } }, 'fascia');
  assert.equal(result.stage, 'needs-evidence'); assert.match(result.diagnosis, /No verified repair or issue-specific disposition/);
  const issue = (await s.workflow.list())[0]; assert.deepEqual(issue.evidenceRefs, ['definition', 'measurement']); assert.equal(issue.mutationReceiptRef, undefined);
  assert.equal((await s.workflow.list()).find(item => item.topicId === 'mesh')!.stage, 'fixed');
});
test('a verified original issue fix is retained without adding a fallback or another inspection', async () => {
  const s = setup(); s.rows.push(s.row('mutation', {}), s.row('verification', {}));
  const result = await investigateSavedIssue({ workflow: s.workflow, prepare: s.prepare, ask: async () => {
    await s.workflow.record({ topicId: 'fascia', stage: 'fixed', diagnosis: 'Measured corner repaired', evidenceRefs: ['mutation', 'verification'], mutationReceiptRef: 'mutation', verificationRef: 'verification' });
    return { text: 'Repaired.' };
  } }, 'fascia');
  assert.equal(result.stage, 'fixed'); assert.equal(result.diagnosis, 'Measured corner repaired');
  assert.equal(s.rows.filter(r => r.text.includes('review.bcf.workflow')).length, 2);
});
test('cancellation preserves investigation history without inventing a final disposition', async () => {
  const s = setup();
  await assert.rejects(investigateSavedIssue({ workflow: s.workflow, prepare: s.prepare, ask: async () => { throw new DOMException('Stopped', 'AbortError'); } }, 'fascia'), { name: 'AbortError' });
  assert.equal((await s.workflow.list())[0].stage, 'investigating');
});
test('a real tool or provider failure is retained on the original issue and rethrown to the caller', async () => {
  const s = setup();
  await assert.rejects(investigateSavedIssue({ workflow: s.workflow, prepare: s.prepare, ask: async () => { throw new Error('Bonsai directive: HTTP 400. Context exceeds 16384 tokens'); } }, 'fascia'), /Context exceeds/);
  const issue = (await s.workflow.list()).find(item => item.topicId === 'fascia')!;
  assert.equal(issue.stage, 'needs-evidence'); assert.match(issue.diagnosis, /Context exceeds 16384 tokens/);
  assert.deepEqual(issue.evidenceRefs, ['definition', 'measurement']);
});
