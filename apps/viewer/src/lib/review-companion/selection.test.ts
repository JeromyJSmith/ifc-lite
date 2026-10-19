/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { selectReviewElement } from './selection';

for (const federated of [false, true]) test(`native select replaces stale surrounding selections (${federated ? 'federated' : 'single'} model)`, async () => {
  const model = { ...fixtureModel('door', { entities: [{ expressId: 47, type: 'IfcDoor' }] }), idOffset: federated ? 1000 : 0 };
  const models = new Map([['door', model]]);
  if (federated) models.set('wall', fixtureModel('wall'));
  useViewerStore.setState({ models, selectedEntity: { modelId: 'door', expressId: 104 },
    selectedEntities: [{ modelId: 'door', expressId: 95 }], selectedEntitiesSet: new Set(['door:104', 'door:95']),
    selectedEntityIds: new Set([104, 95]), selectedEntityId: 104 });
  await selectReviewElement({ modelId: 'door', expressId: 47 });
  const state = useViewerStore.getState(), expected = model.idOffset + 47;
  assert.deepEqual(state.selectedEntity, { modelId: 'door', expressId: 47 });
  assert.deepEqual(state.selectedEntities, []);
  assert.deepEqual([...state.selectedEntityIds], [expected]);
  assert.equal(state.selectedEntityId, expected);
  assert.equal(state.selectedEntitiesSet.size, 1);
  assert.equal(state.isEntitySelected({ modelId: 'door', expressId: 47 }), true);
  assert.equal(state.isEntitySelected({ modelId: 'door', expressId: 104 }), false);
});
test('an unresolved target leaves the current selection untouched', async () => {
  const before = useViewerStore.getState();
  await assert.rejects(selectReviewElement({ modelId: 'absent', expressId: 47 }), /not in the loaded/);
  const after = useViewerStore.getState();
  assert.equal(after.selectedEntityIds, before.selectedEntityIds);
  assert.equal(after.selectedEntity, before.selectedEntity);
});
