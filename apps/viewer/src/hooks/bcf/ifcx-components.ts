/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { BCFViewpoint } from '@ifc-lite/bcf';
import type { FederatedModel } from '@/store/types';
/** Resolve our explicit IFCX authoring IDs only in a uniquely matching loaded source. */
export function resolveIfcxViewpointComponents(viewpoint: BCFViewpoint, models: Map<string, FederatedModel>): BCFViewpoint {
  const next = structuredClone(viewpoint);
  const components = [...(next.components?.selection ?? []), ...(next.components?.visibility?.exceptions ?? []), ...(next.components?.coloring?.flatMap(c => c.components) ?? [])];
  for (const component of components) {
    if (component.ifcGuid || component.originatingSystem !== 'IFC-Lite IFCX' || !component.authoringToolId) continue;
    const hits = [...models.values()].filter(m => m.ifcDataStore?.schemaVersion === 'IFC5' && m.ifcDataStore.entities.getExpressIdByGlobalId(component.authoringToolId!) > 0);
    if (hits.length === 1) component.ifcGuid = component.authoringToolId;
  }
  return next;
}
