/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IfcParser, parseIfcx } from '@ifc-lite/parser';
import { buildIfcxDataStore } from '@/hooks/ingest/viewerModelIngest';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
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
  const withQuantity = source.replace('ENDSEC;\nEND-ISO-10303-21;', `#201=IFCQUANTITYVOLUME('NetVolume',$,$,999.,$);\n#202=IFCELEMENTQUANTITY('0Quantity0000000000001',$,'Qto_WallBaseQuantities',$,$,(#201));\n#203=IFCRELDEFINESBYPROPERTIES('0Relation0000000000001',$,$,$,(#101),#202);\nENDSEC;\nEND-ISO-10303-21;`);
  const bytes = new TextEncoder().encode(withQuantity);
  const data = await new IfcParser().parseColumnar(bytes.buffer);
  const view = new MutablePropertyView(data.properties, 'A');
  configureMutationView(view, data);
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

test('review quantity correction preserves native type/unit, round-trips export and supports Undo', async () => {
  const { bridge, finding, view, data } = await setup();
  const before = await bridge.readElement({ modelId: 'A', expressId: 101 });
  const originalQuantity = before.quantities.find(set => set.name === 'Qto_WallBaseQuantities')?.quantities.find(q => q.name === 'NetVolume');
  assert.ok(originalQuantity);
  assert.equal(originalQuantity.value, 999);
  const proposal = await bridge.previewChanges({ findingId: finding.id, batch: batch([
    { op: 'quantity.set', target: { modelId: 'A', globalId }, qset: 'Qto_WallBaseQuantities', name: 'NetVolume', expected: 999, value: 1 },
  ]) });
  assert.equal(proposal.preview.rows[0].status, 'ready');
  assert.equal(view.getQuantitiesForEntity(101)[0].quantities[0].value, 999, 'preview must not write');
  const result = await bridge.applyChanges({ previewId: proposal.id });
  assert.ok('applied' in result && result.applied && result.ok);
  const corrected = (await bridge.readElement({ modelId: 'A', expressId: 101 })).quantities[0].quantities[0];
  assert.equal(corrected.value, 1);
  assert.equal(corrected.type, originalQuantity.type);
  assert.equal(corrected.unit, originalQuantity.unit);
  const exported = editedModelBytes(data, view);
  const parsed = await new IfcParser().parseColumnar(exported.slice().buffer);
  assert.equal(parsed.getQuantities(101)[0].quantities[0].value, 1);
  const undone = await bridge.undoChanges({ receiptId: result.receipt.id });
  assert.ok('undone' in undone && undone.undone && undone.ok);
  assert.equal((await bridge.readElement({ modelId: 'A', expressId: 101 })).quantities[0].quantities[0].value, 999);
});

test('quantity preview refuses missing quantities and stale expected values without mutating data', async () => {
  const { bridge, finding } = await setup();
  for (const [name, expected] of [['NetVolume', 100], ['InventedVolume', 999]] as const) {
    const proposal = await bridge.previewChanges({ findingId: finding.id, batch: batch([
      { op: 'quantity.set', target: { modelId: 'A', globalId }, qset: 'Qto_WallBaseQuantities', name, expected, value: 1 },
    ]) });
    assert.notEqual(proposal.preview.rows[0].status, 'ready');
    await assert.rejects(bridge.applyChanges({ previewId: proposal.id }), /must be ready/);
  }
  assert.equal((await bridge.readElement({ modelId: 'A', expressId: 101 })).quantities[0].quantities[0].value, 999);
});

test('IFCX native quantities are readable and correctable against a current source-bound finding', async () => {
  const path = '1a16362b-af72-5c77-97df-6b8c0a4ca597';
  const bytes = new TextEncoder().encode(JSON.stringify({ header: { id: 'quantity-review-fixture', ifcxVersion: 'ifcx_alpha', dataVersion: '1' }, imports: [], schemas: {}, data: [
    { path, attributes: { 'bsi::ifc::class': { code: 'IfcWall' }, 'bsi::ifc::prop::Name': 'Fixture wall', 'bsi::ifc::v5a::Qto_WallBaseQuantities::NetVolume': 999 } },
  ] }));
  const parsed = await parseIfcx(bytes.buffer);
  const data = buildIfcxDataStore(parsed, bytes.buffer);
  const expressId = data.entities.getExpressIdByGlobalId(path);
  assert.ok(expressId > 0);
  const view = new MutablePropertyView(data.properties, 'A'); configureMutationView(view, data);
  const models = new Map([['A', { ...fixtureModel('A'), ifcDataStore: data, sourceContentHash: createHash('sha256').update(bytes).digest('hex') }]]);
  useViewerStore.setState({ models, activeModelId: 'A', ifcDataStore: data, mutationViews: new Map([['A', view]]),
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(), editEnabled: true,
    collabRole: null, collabRoomId: null, mutationVersion: 0 });
  const identities = await reviewModels(models);
  const finding: ReviewFinding = { schemaVersion: 1, id: 'current-ifcx-finding', kind: 'note', text: 'Measured quantity correction', createdAt: new Date().toISOString(),
    context: { scopeId: await reviewScope(identities), models: identities, elements: [{ modelId: 'A', expressId, ifcGlobalId: path }], capturedAt: new Date().toISOString(), viewpoint: { guid: 'quantity-view' } } };
  const bridge = createReviewPropertyBridge({ findFinding: id => id === finding.id ? finding : undefined });
  assert.equal((await bridge.readElement({ modelId: 'A', expressId })).quantities[0].quantities[0].value, 999);
  await assert.rejects(bridge.previewChanges({ findingId: finding.id, batch: batch([
    { op: 'quantity.set', target: { modelId: 'A', globalId: 'invented' }, qset: 'Qto_WallBaseQuantities', name: 'NetVolume', expected: 999, value: 1 },
  ]) }), /not uniquely identified/);
  const proposal = await bridge.previewChanges({ findingId: finding.id, batch: batch([
    { op: 'quantity.set', target: { modelId: 'A', globalId: path }, qset: 'Qto_WallBaseQuantities', name: 'NetVolume', expected: 999, value: 1 },
  ]) });
  assert.equal(proposal.preview.rows[0].status, 'ready');
  const result = await bridge.applyChanges({ previewId: proposal.id });
  assert.ok('applied' in result && result.applied && result.ok);
  assert.equal((await bridge.readElement({ modelId: 'A', expressId })).quantities[0].quantities[0].value, 1);
  assert.equal(new TextDecoder().decode(data.source.materialize()), new TextDecoder().decode(bytes), 'quantity overlay must not masquerade as a source geometry mutation');
  const undo = await bridge.undoChanges({ receiptId: result.receipt.id });
  assert.ok('undone' in undo && undo.undone && undo.ok);
  assert.equal((await bridge.readElement({ modelId: 'A', expressId })).quantities[0].quantities[0].value, 999);
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
