/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewProcess, transitionReviewProcess as move, validateReviewProcess, reviewProcessSchema,
  type ReviewProcess, type ReviewProcessEvent, type ReviewProcessReceipt, type ReviewProcessReadback } from './process';

// Contract fixtures only. These remain in memory and assert transition rules;
// they are not model execution evidence or receipts saved in a project directory.
const at = '2026-10-19T20:00:00.000Z';
const globalId = '0abcdefghijklmnopqrstu';
function fresh() {
  return createReviewProcess({ id: 'fixture:review', scopeId: 'fixture:scope', directive: 'Inspect; record only grounded candidates.',
    models: [{ id: 'fixture:house', name: 'Fixture model', sourceIdentity: 'sha256:' + 'a'.repeat(64) }], createdAt: at });
}
function inspected(count = 1) {
  let process = move(fresh(), { kind: 'start', at });
  return move(process, { kind: 'inspection', at,
    inspection: { id: 'fixture:inspection', contextRef: 'fixture:context', viewpointId: 'fixture:camera', snapshotRef: 'fixture:image', rawResponseRef: 'fixture:raw', model: 'fixture:Bonsai', summary: 'A window is visible.' },
    findings: Array.from({ length: count }, (_, i) => ({ id: `fixture:f${i}`, text: 'Possible metadata inconsistency; inspect the native value.' })),
  });
}
function previewed() {
  let process = move(inspected(), { kind: 'bind', at, findingId: 'fixture:f0', element: { modelId: 'fixture:house', expressId: 42, ifcGlobalId: globalId, sourceIdentity: 'sha256:' + 'a'.repeat(64) } });
  return move(process, { kind: 'preview', at, findingId: 'fixture:f0', preview: { id: 'fixture:preview', digest: 'fixture:digest', mutationVersion: 7,
    changes: [{ field: 'Pset_WallCommon.IsExternal', before: false, after: true }], artifactRef: 'fixture:native-preview' } });
}
const approval = { kind: 'approve', at, findingId: 'fixture:f0', previewId: 'fixture:preview', digest: 'fixture:digest', actor: { kind: 'human', id: 'fixture:reviewer' }, method: 'native-review-click', approvalRef: 'fixture:click' } as const;
const receipt: ReviewProcessReceipt = { id: 'fixture:receipt', digest: 'fixture:digest', status: 'applied', modelId: 'fixture:house', globalId,
  changes: [{ field: 'Pset_WallCommon.IsExternal', before: false, after: true }], nativeBatchIds: ['fixture:batch'], artifactRef: 'fixture:native-receipt' };
function readback(value: boolean): ReviewProcessReadback {
  return { receiptId: receipt.id, modelId: receipt.modelId, globalId, values: [{ field: receipt.changes[0].field, value }], artifactRef: 'fixture:native-readback' };
}
function applied() { return move(move(previewed(), approval), { kind: 'apply', at, findingId: 'fixture:f0', receipt }); }

test('native before/after readback is required for verified and undone states, and history remains immutable', () => {
  const before = applied(), original = structuredClone(before);
  const verified = move(before, { kind: 'verify', at, findingId: 'fixture:f0', readback: readback(true) });
  assert.equal(verified.findings[0].status, 'verified');
  assert.deepEqual(before, original);
  const undone = move(verified, { kind: 'undo', at, findingId: 'fixture:f0', readback: readback(false), undoRef: 'fixture:native-undo' });
  assert.equal(undone.findings[0].status, 'undone');
  assert.equal(undone.findings[0].receipt!.changes[0].after, true);
  assert.equal(undone.findings[0].readback!.values[0].value, false);
  assert.equal(validateReviewProcess(undone).ok, true);
});

test('agent self-approval, wrong preview digest, skipped approval and changed receipt values are refused', () => {
  assert.throws(() => move(previewed(), { kind: 'apply', at, findingId: 'fixture:f0', receipt }), /approval/);
  assert.throws(() => move(previewed(), { ...approval, actor: { kind: 'agent', id: 'fixture:Bonsai' } } as unknown as ReviewProcessEvent), /human|constant|schema|oneOf/i);
  assert.throws(() => move(previewed(), { ...approval, digest: 'another-preview' }), /digest/);
  const approved = move(previewed(), approval);
  assert.throws(() => move(approved, { kind: 'apply', at, findingId: 'fixture:f0', receipt: { ...receipt, changes: [{ field: receipt.changes[0].field, before: false, after: false }] } }), /approved values/);
  assert.throws(() => move(approved, { kind: 'apply', at, findingId: 'fixture:f0', receipt: { ...receipt, modelId: 'wrong-model' } }), /model\/element/);
});

test('incorrect verification and undo never manufacture success or erase the native applied record', () => {
  const process = applied();
  assert.throws(() => move(process, { kind: 'verify', at, findingId: 'fixture:f0', readback: readback(false) }), /does not match/);
  assert.throws(() => move(process, { kind: 'undo', at, findingId: 'fixture:f0', readback: readback(true), undoRef: 'fixture:undo' }), /does not match/);
  const blocked = move(process, { kind: 'block', at, findingId: 'fixture:f0', stage: 'undo', reason: 'Native undo refused a newer edit.', evidenceRefs: ['fixture:refusal'] });
  assert.equal(blocked.findings[0].status, 'blocked');
  assert.deepEqual(blocked.findings[0].receipt, receipt);
});

test('review completion permits zero grounded findings and never requires a quota of five', () => {
  const zero = move(inspected(0), { kind: 'finish', at, evidenceRefs: ['fixture:actual-inspection-reference'] });
  assert.equal(zero.status, 'completed'); assert.deepEqual(zero.findings, []);
  assert.throws(() => move(move(fresh(), { kind: 'start', at }), { kind: 'finish', at, evidenceRefs: [] }), /without.*inspection/);
  assert.throws(() => inspected(6), /five|5|items|schema|oneOf/i);
  const five = inspected(5);
  assert.throws(() => move(five, { kind: 'inspection', at, inspection: { ...five.inspections[0], id: 'fixture:second-view' }, findings: [{ id: 'fixture:sixth', text: 'Extra' }] }), /five/);
});

test('binding requires the exact source revision and imported snapshots must replay their full history', () => {
  assert.throws(() => move(inspected(), { kind: 'bind', at, findingId: 'fixture:f0', element: { modelId: 'fixture:house', expressId: 42, ifcGlobalId: globalId, sourceIdentity: 'different-source' } }), /revision/);
  const tampered: ReviewProcess = structuredClone(previewed());
  tampered.findings[0].status = 'verified';
  assert.equal(validateReviewProcess(tampered).ok, false);
  const altered = applied(); altered.events[2] = { ...altered.events[2], at: 'not-a-date' };
  assert.equal(validateReviewProcess(altered).ok, false);
});

test('interruption is append-only and retry requires a new linked run; URI/hash linkage is optional and validated', () => {
  const running = move(fresh(), { kind: 'start', at });
  const stopped = move(running, { kind: 'interrupt', at, reason: 'User paused review.', evidenceRefs: ['fixture:completed-tool-steps'] });
  assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.events.length, 2);
  assert.throws(() => move(stopped, { kind: 'start', at }), /new process/);
  const retry = createReviewProcess({ ...fresh(), id: 'fixture:retry', operation: { operation_id: 'review.visual.v1', run_id: 'fixture:retry', project_id: 'fixture:project', parent_run_id: stopped.id, qualification: 'unqualified' }, artifacts: [{ uri: 'fixture:artifact', sha256: 'a'.repeat(64), role: 'input' }] });
  assert.equal(retry.operation!.parent_run_id, stopped.id);
  assert.equal(retry.operation!.qualification, 'unqualified');
  assert.equal(validateReviewProcess({ ...retry, artifacts: [{ uri: 'fixture:artifact', sha256: 'not-a-hash', role: 'input' }] }).ok, false);
  assert.equal(reviewProcessSchema.$schema, 'http://json-schema.org/draft-07/schema#');
});

test('a refused un-applied preview can be refreshed, while an applied failure cannot be hidden by re-preview', () => {
  const first = previewed(), preview = first.findings[0].preview!;
  const blocked = move(first, { kind: 'block', at, findingId: 'fixture:f0', stage: 'preview', reason: 'Edit mode disabled', evidenceRefs: ['fixture:denial'] });
  const retry = move(blocked, { kind: 'preview', at, findingId: 'fixture:f0', preview: { ...preview, id: 'fixture:refreshed-preview' } });
  assert.equal(retry.findings[0].status, 'previewed'); assert.equal(retry.findings[0].approval, undefined);
  const appliedBlock = move(applied(), { kind: 'block', at, findingId: 'fixture:f0', stage: 'readback', reason: 'Mismatch', evidenceRefs: ['fixture:actual-mismatch'] });
  assert.throws(() => move(appliedBlock, { kind: 'preview', at, findingId: 'fixture:f0', preview }), /explicit recovery/);
  assert.deepEqual(appliedBlock.findings[0].receipt, receipt);
});

test('native IFCX UUID identities bind and survive process validation; arbitrary labels remain invalid', () => {
  const element = { modelId: 'fixture:house', expressId: 7, ifcGlobalId: '077a235f-f9ba-5a58-8ea5-30d3992aee32', sourceIdentity: 'sha256:' + 'a'.repeat(64) };
  const bound = move(inspected(), { kind: 'bind', at, findingId: 'fixture:f0', element });
  validateReviewProcess(bound);
  assert.equal(bound.findings[0].element?.ifcGlobalId, element.ifcGlobalId);
  assert.throws(() => move(inspected(), { kind: 'bind', at, findingId: 'fixture:f0', element: { ...element, ifcGlobalId: 'ceiling-label' } }));
});
