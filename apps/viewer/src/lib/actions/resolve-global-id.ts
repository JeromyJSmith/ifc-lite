/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one IFC GlobalId → (model, express id) resolution of reviewed changes
 * and reviewed authoring: the parsed GlobalId index of every loaded model,
 * plus the elements this session created (overlay entities carry their
 * GlobalId in attribute 0 and are absent from the parsed index), minus
 * deleted ones. A GlobalId found in several models is ambiguous until the
 * proposal names the model.
 */

import { effectiveMetadataRecord, getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { liveEntityConforms } from '@ifc-lite/create';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';

export interface GlobalIdTarget { globalId: string; modelId?: string }
export type GlobalIdResolution = { modelId: string; expressId: number } | 'missing' | 'ambiguous';

export function resolveGlobalId(state: Pick<ViewerState, 'models' | 'mutationViews'>, target: GlobalIdTarget): GlobalIdResolution {
  const hits: Array<{ modelId: string; expressId: number }> = [];
  for (const [modelId, model] of state.models) {
    if (target.modelId && target.modelId !== modelId) continue;
    const view = state.mutationViews.get(modelId);
    const store = model.ifcDataStore;
    if (!store) continue;
    const changed = new Set(view?.getEffectiveChanges().map(change => change.entityId));
    // The unchanged parsed column remains the fast path. Native metadata owns
    // named/positional precedence for changed and authored identities (#7284).
    const currentGuid = (id: number) => (changed.has(id) && (store.schemaVersion !== 'IFC5' || view?.getPositionalMutationsForEntity(id)?.has(0) || view?.getAttributeMutationsForEntity(id).some(row => row.name === 'GlobalId'))) || view?.getNewEntity(id)
      ? effectiveMetadataRecord(store, id, view)?.attributes[0] : store.entities.getGlobalId(id);
    // IFCX has columnar path identities, not STEP entity records. Resolving a
    // visible node is a read operation, not permission to invoke STEP builders.
    const root = (id: number) => store.schemaVersion === 'IFC5'
      ? !view?.isDeleted(id) && getInheritanceChainAcrossSchemas(view?.getTypeMutations().get(id)?.newType ?? store.entities.getTypeName(id)).includes('IfcRoot')
      : liveEntityConforms(store, id, 'IfcRoot', view);
    const parsed = store.entities.getExpressIdByGlobalId(target.globalId);
    if (parsed > 0 && !view?.isDeleted(parsed) && currentGuid(parsed) === target.globalId
      && root(parsed)) {
      hits.push({ modelId, expressId: parsed });
      continue;
    }
    // A parsed index may be absent, stale after a native identity edit, or point
    // at a non-root Name. Recover current roots through the canonical inventory.
    for (const { expressId } of iterateEffectiveEntityIds(store, view)) {
      if (currentGuid(expressId) === target.globalId && root(expressId)) {
        hits.push({ modelId, expressId }); break;
      }
    }
  }
  if (hits.length === 0) return 'missing';
  return hits.length > 1 ? 'ambiguous' : hits[0];
}
