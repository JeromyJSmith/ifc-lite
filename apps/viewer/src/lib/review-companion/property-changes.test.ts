/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { parseModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { createReviewPropertyBridge } from './property-changes';
import { reviewModels, reviewScope } from './context';
import type { ReviewFinding } from './types';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const globalId = '0Wall00000000000000101';
const source = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('review-test.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);\n#101=IFCWALL('${globalId}',$,'W1',$,$,$,$,'T1',$);\nENDSEC;\nEND-ISO-10303-21;`;
async function setup(editEnabled = true) {
  const bytes = new TextEncoder().encode(source);
  const data = await new IfcParser().parseColumnar(bytes.buffer);
  const view = new MutablePropertyView(data.properties, 'A');
  const models = new Map([['A', { ...fixtureModel('A'), ifcDataStore: data, sourceContentHash: createHash('sha256').update(bytes).digest('hex') }]]);
  useViewerStore.setState({ models, activeModelId: 'A', ifcDataStore: data, mutationViews: new Map([['A', view]]),
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(),
    editEnabled, collabRole: null, collabRoomId: null, mutationVersion: 0 });
  const identities = await reviewModels(models);
  const finding: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'note', text: 'Owner requests descriptive name correction to Wall 1.', createdAt: new Date().toISOString(),
    context: { scopeId: await reviewScope(identities), models: identities, elements: [{ modelId: 'A', expressId: 101, ifcGlobalId: globalId }],
      capturedAt: new Date().toISOString(), viewpoint: { guid: 'test-view' } } };
  const bridge = createReviewPropertyBridge({ findFinding: id => id === finding.id ? finding : undefined });
  return { bridge, finding, view, data };
}
function batch(changes: unknown[] = [{ op: 'attribute.set', target: { modelId: 'A', globalId }, name: 'Name', expected: 'W1', value: 'Wall 1' }]) {
  return parseModelChangeBatch(JSON.stringify({ version: 1, kind: 'model.changes', title: 'Owner requested name correction', changes }));
}

test('finding-bound native preview writes nothing; apply verifies effective data, STEP roundtrip and native Undo', async () => {
  const { bridge, finding, view, data } = await setup();
  const before = await bridge.readElement({ modelId: 'A', expressId: 101 });
  assert.equal(before.attributes.Name, 'W1');
  const proposal = await bridge.previewChanges({ findingId: finding.id, batch: batch() });
  assert.equal(proposal.preview.rows[0].status, 'ready');
  assert.equal((await bridge.readElement({ modelId: 'A', expressId: 101 })).attributes.Name, 'W1');
  const result = await bridge.applyChanges({ previewId: proposal.id });
  assert.ok('applied' in result && result.applied && result.ok);
  assert.equal(result.persisted, true);
  assert.deepEqual(result.readback, [{ index: 0, field: 'Name', actual: 'Wall 1', matches: true }]);
  const exported = editedModelBytes(data, view);
  const parsed = await new IfcParser().parseColumnar(exported.slice().buffer);
  assert.equal(parsed.entities.getName(parsed.entities.getExpressIdByGlobalId(globalId)), 'Wall 1');
  assert.equal(data.entities.getName(101), 'W1', 'immutable parsed source was not overwritten');
  const undone = await bridge.undoChanges({ receiptId: result.receipt.id });
  assert.ok('undone' in undone && undone.undone && undone.ok);
  assert.equal((await bridge.readElement({ modelId: 'A', expressId: 101 })).attributes.Name, 'W1');
});

test('bridge rejects dimension metadata disguised as geometry repair and targets not identified by the finding', async () => {
  const { bridge, finding } = await setup();
  await assert.rejects(bridge.previewChanges({ findingId: finding.id, batch: batch([{ op: 'property.set', target: { modelId: 'A', globalId }, pset: 'Pset_WallCommon', name: 'Height', expected: null, value: 3 }]) }), /geometry fields require native authoring/);
  const foreign = batch([{ op: 'attribute.set', target: { modelId: 'A', globalId: '0Project0000000000000a' }, name: 'Name', expected: 'P', value: 'Wrong target' }]);
  await assert.rejects(bridge.previewChanges({ findingId: finding.id, batch: foreign }), /not uniquely identified/);
  assert.equal((await bridge.readElement({ modelId: 'A', expressId: 101 })).attributes.Name, 'W1');
});

test('edit-mode policy and expected-before conflict are retained without bypass', async () => {
  const { bridge, finding } = await setup(false);
  const denied = await bridge.previewChanges({ findingId: finding.id, batch: batch() });
  assert.equal(denied.preview.rows[0].status, 'denied');
  await assert.rejects(bridge.applyChanges({ previewId: denied.id }), /must be ready/);
  useViewerStore.getState().setEditEnabled(true);
  const conflicted = await bridge.previewChanges({ findingId: finding.id,
    batch: batch([{ op: 'attribute.set', target: { modelId: 'A', globalId }, name: 'Name', expected: 'Not actual', value: 'Wall 1' }]) });
  assert.equal(conflicted.preview.rows[0].status, 'conflict');
  await assert.rejects(bridge.applyChanges({ previewId: conflicted.id }), /must be ready/);
});

test('scope or mutation changes after preview refuse apply and leave the actual current value intact', async () => {
  const { bridge, finding } = await setup();
  const proposal = await bridge.previewChanges({ findingId: finding.id, batch: batch() });
  useViewerStore.setState({ mutationVersion: 1 });
  assert.deepEqual(await bridge.applyChanges({ previewId: proposal.id }), { ok: false, reason: 'stale' });
  const models = new Map(useViewerStore.getState().models);
  models.set('A', { ...models.get('A')!, sourceContentHash: 'f'.repeat(64) });
  useViewerStore.setState({ models });
  await assert.rejects(bridge.applyChanges({ previewId: proposal.id }), /exact reviewed model revisions/);
  assert.equal((await bridge.readElement({ modelId: 'A', expressId: 101 })).attributes.Name, 'W1');
});
