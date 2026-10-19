/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import type { EntityRef } from '@/store/types';

/** Replace both property and renderer selections before framing or capture. */
export async function selectReviewElement(ref: EntityRef) {
  const state = useViewerStore.getState(), model = state.models.get(ref.modelId);
  if (!model?.ifcDataStore?.entities.getTypeName(ref.expressId)) throw new Error('Element is not in the loaded model.');
  const globalId = toGlobalIdFromModels(state.models, ref.modelId, ref.expressId);
  state.clearEntitySelection();
  state.addEntityToSelection(ref);
  state.setSelectedEntityIds([globalId]);
  state.setSelectedEntityId(globalId);
  const actual = useViewerStore.getState();
  if (actual.selectedEntityId !== globalId || actual.selectedEntityIds.size !== 1 || !actual.selectedEntityIds.has(globalId)
    || actual.selectedEntitiesSet.size !== 1 || actual.selectedEntity?.modelId !== ref.modelId || actual.selectedEntity.expressId !== ref.expressId)
    throw new Error('Viewer selection did not match the requested element.');
  return { ...actual.selectedEntity, selectedEntityIds: [...actual.selectedEntityIds] };
}
