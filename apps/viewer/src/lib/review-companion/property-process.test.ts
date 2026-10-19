/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewPropertyProcessEvents } from './property-process';
import { createReviewProcess, transitionReviewProcess, validateReviewProcess, type ReviewProcessEvent } from './process';
import type { ReviewPropertyProposal } from './property-changes';

// In-memory protocol fixtures exercise process attribution. They are not native
// model executions or persisted receipts and never enter project evidence.
const guid = '0abcdefghijklmnopqrstu';
function fixture() {
  const at = '2020-01-01T00:00:00.000Z';
  let process = createReviewProcess({ id: 'fixture:process', scopeId: 'fixture:scope', directive: 'Correct an owner-supplied descriptive value.',
    models: [{ id: 'fixture:model', name: 'Fixture IFC', sourceIdentity: `sha256:${'a'.repeat(64)}` }], createdAt: at });
  const append = async (event: ReviewProcessEvent) => { process = transitionReviewProcess(process, event); return process; };
  process = transitionReviewProcess(process, { kind: 'start', at });
  process = transitionReviewProcess(process, { kind: 'inspection', at,
    inspection: { id: 'fixture:inspection', contextRef: 'fixture:context', viewpointId: 'fixture:view', snapshotRef: 'fixture:image', rawResponseRef: 'fixture:raw', model: 'fixture:model-response', summary: 'A wall is visible.' },
    findings: [{ id: 'fixture:finding', text: 'Inspect descriptive metadata.' }] });
  process = transitionReviewProcess(process, { kind: 'bind', at, findingId: 'fixture:finding',
    element: { modelId: 'fixture:model', expressId: 42, ifcGlobalId: guid, sourceIdentity: `sha256:${'a'.repeat(64)}` } });
  const change = { op: 'attribute.set' as const, target: { modelId: 'fixture:model', globalId: guid }, name: 'Name' as const, expected: 'Wall', value: 'Wall 1' };
  const proposal: ReviewPropertyProposal = { id: 'fixture:preview', findingId: 'fixture:picked-child', scopeId: process.scopeId,
    batch: { version: 1, kind: 'model.changes', title: 'Owner descriptive correction', changes: [change] },
    preview: { batch: { version: 1, kind: 'model.changes', title: 'Owner descriptive correction', changes: [change] }, digest: 'mc1-fixture-native-digest', mutationVersion: 7,
      rows: [{ index: 0, status: 'ready', modelId: 'fixture:model', expressId: 42, change, current: 'Wall' }] }, origin: 'fixture:review' };
  const events = createReviewPropertyProcessEvents({ current: () => process,
    canonicalFindingId: id => id === 'fixture:picked-child' ? 'fixture:finding' : undefined, append });
  const receipt = { id: 'fixture:native-receipt', digest: proposal.preview.digest, status: 'applied',
    applied: [{ index: 0, modelId: 'fixture:model', globalId: guid, field: 'Name', before: 'Wall', after: 'Wall 1' }],
    batches: [{ modelId: 'fixture:model', batchId: 'fixture:native-batch' }] };
  const actual = { ok: true, applied: true, persisted: true, receipt, readback: [{ index: 0, field: 'Name', actual: 'Wall 1', matches: true }] };
  return { events, proposal, actual, receipt, current: () => process };
}

test('preview → native human click → actual native receipt and readback map to replayable verified process', async () => {
  const f = fixture();
  await f.events.preview(f.proposal, 'fixture:preview-artifact');
  assert.deepEqual(f.current().findings[0].preview?.changes, [{ field: 'Name', before: 'Wall', after: 'Wall 1' }]);
  assert.equal(f.current().findings[0].preview?.digest, f.proposal.preview.digest);
  await f.events.approve(f.proposal, 'fixture:human-native-click');
  assert.equal(f.current().findings[0].approval?.actor.kind, 'human');
  await f.events.applied(f.proposal, f.actual, 'fixture:actual-apply-and-readback');
  assert.equal(f.current().findings[0].status, 'verified');
  assert.equal(f.current().findings[0].receipt?.artifactRef, 'fixture:actual-apply-and-readback');
  assert.equal(f.current().findings[0].readback?.values[0].value, 'Wall 1');
  assert.equal(validateReviewProcess(f.current()).ok, true);
});

test('standalone or unmapped proposals leave the process untouched', async () => {
  const f = fixture(), before = structuredClone(f.current());
  const unmapped = { ...f.proposal, findingId: 'standalone-finding' };
  await f.events.preview(unmapped, 'fixture:preview'); await f.events.approve(unmapped, 'fixture:approval');
  await f.events.applied(unmapped, f.actual, 'fixture:apply'); await f.events.undone(unmapped, {}, 'fixture:undo');
  assert.deepEqual(f.current(), before);
});

test('conflicts and a different bound element are blocked rather than recorded as a ready preview', async () => {
  const f = fixture();
  const conflict = structuredClone(f.proposal); conflict.preview.rows[0].status = 'conflict';
  await f.events.preview(conflict, 'fixture:conflict');
  assert.equal(f.current().findings[0].status, 'blocked');
  assert.equal(f.current().events.some(event => event.kind === 'preview'), false);
  const other = fixture();
  const wrong = structuredClone(other.proposal); wrong.preview.rows[0].expressId = 999;
  await other.events.preview(wrong, 'fixture:wrong-element');
  assert.equal(other.current().findings[0].status, 'blocked');
});

test('actual application survives journal attribution when persistence fails, but no verification is invented', async () => {
  const f = fixture(); await f.events.preview(f.proposal, 'fixture:preview'); await f.events.approve(f.proposal, 'fixture:click');
  await f.events.applied(f.proposal, { ...f.actual, ok: false, persisted: false }, 'fixture:persistence-refusal');
  assert.equal(f.current().findings[0].receipt?.id, f.receipt.id);
  assert.equal(f.current().findings[0].status, 'blocked');
  assert.equal(f.current().events.some(event => event.kind === 'verify'), false);
  assert.match(f.current().findings[0].reason ?? '', /persistence/);
});

test('wrong native values or wrong readback cannot claim successful property verification', async () => {
  const f = fixture(); await f.events.preview(f.proposal, 'fixture:preview'); await f.events.approve(f.proposal, 'fixture:click');
  await f.events.applied(f.proposal, { ...f.actual, readback: [{ index: 0, field: 'Name', actual: 'Different value', matches: true }] }, 'fixture:mismatch');
  assert.equal(f.current().findings[0].status, 'blocked');
  assert.equal(f.current().events.some(event => event.kind === 'verify'), false);
  const other = fixture(); await other.events.preview(other.proposal, 'fixture:preview'); await other.events.approve(other.proposal, 'fixture:click');
  await other.events.applied(other.proposal, { ...other.actual, receipt: { ...other.receipt, digest: 'wrong-digest' } }, 'fixture:wrong-receipt');
  assert.equal(other.current().events.some(event => event.kind === 'apply'), false);
});

test('undo requires actual persisted before-value readback, not merely an undone receipt label', async () => {
  const f = fixture(); await f.events.preview(f.proposal, 'fixture:preview'); await f.events.approve(f.proposal, 'fixture:click');
  await f.events.applied(f.proposal, f.actual, 'fixture:apply');
  await f.events.undone(f.proposal, { ok: true, undone: true, persisted: true, receipt: { ...f.receipt, status: 'undone' },
    readback: [{ index: 0, field: 'Name', actual: 'Wall', matches: true }] }, 'fixture:undo-readback');
  assert.equal(f.current().findings[0].status, 'undone');
  assert.equal(f.current().findings[0].readback?.values[0].value, 'Wall');
  const missing = fixture(); await missing.events.preview(missing.proposal, 'fixture:preview'); await missing.events.approve(missing.proposal, 'fixture:click');
  await missing.events.applied(missing.proposal, missing.actual, 'fixture:apply');
  await missing.events.undone(missing.proposal, { ok: true, undone: true, persisted: true, receipt: { ...missing.receipt, status: 'undone' } }, 'fixture:no-readback');
  assert.equal(missing.current().findings[0].status, 'blocked');
  assert.equal(missing.current().events.some(event => event.kind === 'undo'), false);
});
