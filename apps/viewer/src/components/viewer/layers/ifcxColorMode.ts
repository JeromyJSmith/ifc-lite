/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFCX colour mode for federated layer stacks: "material" (default) keeps each mesh's colour from the file
 * (bsi::ifc::presentation::diffuseColor / IfcSurfaceStyle), "layer" paints every entity with the colour of the layer
 * that wins it. Layer colours are recorded at federation time (useIfcFederation) keyed by global id (federated IFCX
 * layers share idOffset 0) and pushed through the shared paint channel `pendingColorUpdates`; an empty map clears
 * them, which restores the file colours.
 */
import { useViewerStore } from '../../../store/index.js';

export type IfcxColorMode = 'material' | 'layer';
type Rgba = [number, number, number, number];

let mode: IfcxColorMode = 'material';
let materialColors = new Map<number, Rgba>();
let layerColors = new Map<number, Rgba>();
const listeners = new Set<() => void>();
let snapshot: { mode: IfcxColorMode; count: number } = { mode, count: 0 };

function emit() {
  snapshot = { mode, count: layerColors.size };
  for (const l of listeners) l();
}

function applyColorsToStoreModels(activeMap: Map<number, Rgba>, nextMode: IfcxColorMode) {
  const store = useViewerStore.getState();
  for (const [id, model] of store.models.entries()) {
    if (!id.startsWith('layer') || !model.geometryResult?.meshes) continue;
    for (const mesh of model.geometryResult.meshes) {
      const c = activeMap.get(mesh.expressId);
      if (c) mesh.color = [...c] as Rgba;
    }
  }
  store.setPendingColorUpdates(nextMode === 'layer' ? new Map(layerColors) : new Map());
}

export function subscribeIfcxColorMode(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getIfcxColorModeState = () => snapshot;

/** Called by the federation loader with the file material colour and winning layer colour of every entity. */
export function recordIfcxLayerColors(
  nextLayerColors: Map<number, Rgba>,
  nextMaterialColors?: Map<number, Rgba>,
) {
  layerColors = new Map(nextLayerColors);
  if (nextMaterialColors) {
    materialColors = new Map(nextMaterialColors);
  }
  applyColorsToStoreModels(mode === 'layer' ? layerColors : materialColors, mode);
  emit();
}

export function setIfcxColorMode(next: IfcxColorMode) {
  mode = next;
  applyColorsToStoreModels(next === 'layer' ? layerColors : materialColors, next);
  emit();
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__MARPA_IFCX_COLOR_MODE__ = {
    getState: getIfcxColorModeState,
    setMode: setIfcxColorMode,
    getLayerColors: () => Object.fromEntries(layerColors),
    getMaterialColors: () => Object.fromEntries(materialColors),
  };
}


