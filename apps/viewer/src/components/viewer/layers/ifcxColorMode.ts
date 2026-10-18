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

export type IfcxColorMode = 'delineate' | 'zone' | 'material' | 'layer';
export type Rgba = [number, number, number, number];

let mode: IfcxColorMode = 'delineate';
let materialColors = new Map<number, Rgba>();
let layerColors = new Map<number, Rgba>();
let delineateColors = new Map<number, Rgba>();
let zoneColors = new Map<number, Rgba>();
const listeners = new Set<() => void>();
let snapshot: { mode: IfcxColorMode; count: number } = { mode, count: 0 };

/** High-contrast 24-color architectural delineation palette for individual wall runs and assemblies. */
const WALL_DELINEATE_PALETTE: ReadonlyArray<Rgba> = [
  [0.96, 0.36, 0.22, 1.0], // Coral Vermilion
  [0.15, 0.65, 0.95, 1.0], // Cerulean Blue
  [0.98, 0.72, 0.12, 1.0], // Golden Amber
  [0.16, 0.80, 0.55, 1.0], // Emerald Mint
  [0.62, 0.34, 0.92, 1.0], // Electric Violet
  [0.95, 0.25, 0.58, 1.0], // Vivid Rose Magenta
  [0.08, 0.78, 0.82, 1.0], // Cyan Turquoise
  [0.98, 0.52, 0.14, 1.0], // Tangerine Orange
  [0.52, 0.82, 0.18, 1.0], // Chartreuse Lime
  [0.28, 0.45, 0.92, 1.0], // Cobalt Indigo
  [0.88, 0.22, 0.28, 1.0], // Crimson Red
  [0.12, 0.72, 0.68, 1.0], // Deep Teal
  [0.85, 0.45, 0.88, 1.0], // Orchid Purple
  [0.94, 0.62, 0.28, 1.0], // Warm Ochre
  [0.24, 0.76, 0.38, 1.0], // Kelly Green
  [0.42, 0.58, 0.96, 1.0], // Periwinkle Blue
  [0.92, 0.38, 0.45, 1.0], // Salmon Carmine
  [0.18, 0.84, 0.72, 1.0], // Aquamarine
  [0.78, 0.64, 0.22, 1.0], // Brass Gold
  [0.54, 0.38, 0.78, 1.0], // Amethyst
];

const ROOF_DELINEATE_PALETTE: ReadonlyArray<Rgba> = [
  [0.32, 0.44, 0.62, 1.0], // West Main Gable - Slate Blue
  [0.44, 0.36, 0.58, 1.0], // East Main Gable - Dusk Plum
  [0.26, 0.54, 0.58, 1.0], // East Cross Gable South - Steel Teal
  [0.36, 0.58, 0.48, 1.0], // East Cross Gable North - Patina Green
  [0.64, 0.46, 0.32, 1.0], // East Rear Return Lean-To - Copper Bronze
  [0.48, 0.52, 0.56, 1.0], // Back Wing Membrane - Zinc Grey
  [0.58, 0.38, 0.34, 1.0], // Front Porch Low-Slope - Terracotta Shingle
];

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function computeDelineateAndZoneColorsFromStore() {
  const store = useViewerStore.getState();
  const dataStore = store.ifcDataStore;
  const nextDelineate = new Map<number, Rgba>();
  const nextZone = new Map<number, Rgba>();

  let wallIdx = 0;
  let roofIdx = 0;
  let balusterIdx = 0;

  for (const [id, model] of store.models.entries()) {
    if (!id.startsWith('layer') || !model.geometryResult?.meshes) continue;
    const ds = model.ifcDataStore ?? dataStore;
    for (const mesh of model.geometryResult.meshes) {
      const eid = mesh.expressId;
      if (!materialColors.has(eid)) {
        materialColors.set(eid, [...mesh.color] as Rgba);
      }
      const name = (ds?.entities?.getName(eid) || '').trim();
      const lower = name.toLowerCase();
      const ifcType = mesh.ifcType || ds?.entities?.getTypeName(eid) || '';
      const storeyId = ds?.spatialHierarchy?.elementToStorey?.get(eid);
      const storeyName = (storeyId ? ds?.entities?.getName(storeyId) : '')?.toLowerCase() || '';

      // 1. DELINEATE MODE COLOR
      let dColor: Rgba;
      if (ifcType === 'IfcPlate' || lower.includes('glazing')) {
        dColor = [0.48, 0.86, 0.98, 0.36];
      } else if (ifcType === 'IfcWindow') {
        dColor = [0.18, 0.82, 0.96, 1.0]; // Crisp Cyan Window Frame
      } else if (ifcType === 'IfcDoor') {
        dColor = lower.includes('west')
          ? [0.98, 0.45, 0.15, 1.0]
          : lower.includes('east')
            ? [0.12, 0.78, 0.88, 1.0]
            : [0.96, 0.24, 0.48, 1.0];
      } else if (ifcType === 'IfcStairFlight' || ifcType === 'IfcStair') {
        if (lower.includes('lower')) dColor = [1.0, 0.42, 0.10, 1.0]; // Vivid Tangerine
        else if (lower.includes('middle')) dColor = [1.0, 0.74, 0.05, 1.0]; // Vivid Gold
        else if (lower.includes('upper')) dColor = [0.96, 0.22, 0.36, 1.0]; // Vivid Crimson-Coral
        else if (lower.includes('basement')) dColor = [0.85, 0.48, 0.12, 1.0]; // Deep Amber
        else dColor = [0.98, 0.56, 0.12, 1.0];
      } else if (ifcType === 'IfcRailing' || lower.includes('balustrade') || lower.includes('handrail')) {
        dColor = [0.58, 0.22, 0.92, 1.0]; // Electric Royal Purple
      } else if (ifcType === 'IfcMember') {
        if (lower.includes('stringer')) {
          dColor = [0.78, 0.12, 0.22, 1.0]; // Deep Carmine Stringer
        } else if (lower.includes('post') || lower.includes('newel')) {
          dColor = [0.96, 0.12, 0.56, 1.0]; // Vivid Magenta Newel Post
        } else if (lower.includes('baluster')) {
          dColor = (balusterIdx++ % 2 === 0)
            ? [0.05, 0.82, 0.96, 1.0] // Bright Cyan Baluster
            : [0.12, 0.94, 0.76, 1.0]; // Bright Mint Aqua Baluster
        } else {
          dColor = [0.88, 0.68, 0.24, 1.0]; // Trim / Fascia Gold
        }
      } else if (ifcType === 'IfcColumn') {
        dColor = [0.98, 0.82, 0.24, 1.0]; // Porch Post Gold
      } else if (ifcType === 'IfcRoof') {
        dColor = ROOF_DELINEATE_PALETTE[roofIdx++ % ROOF_DELINEATE_PALETTE.length];
      } else if (ifcType === 'IfcSlab') {
        if (lower.includes('upper')) dColor = [0.82, 0.62, 0.38, 1.0]; // Warm Oak
        else if (lower.includes('main')) dColor = [0.72, 0.52, 0.34, 1.0]; // Walnut Sandstone
        else if (lower.includes('basement')) dColor = [0.46, 0.52, 0.58, 1.0]; // Concrete Slate
        else dColor = [0.88, 0.48, 0.28, 1.0]; // Bar top / Landing Terracotta
      } else if (ifcType === 'IfcWall' || ifcType === 'IfcWallStandardCase') {
        if (lower.includes('foundation')) {
          dColor = [0.45, 0.48, 0.54, 1.0];
        } else if (lower.includes('stairwell')) {
          if (lower.includes('upper')) dColor = [0.68, 0.42, 0.94, 1.0];
          else if (lower.includes('west')) dColor = [0.82, 0.32, 0.88, 1.0];
          else if (lower.includes('south')) dColor = [0.52, 0.36, 0.92, 1.0];
          else dColor = [0.74, 0.28, 0.76, 1.0];
        } else {
          const idx = (wallIdx++ + hashString(name)) % WALL_DELINEATE_PALETTE.length;
          dColor = WALL_DELINEATE_PALETTE[idx];
        }
      } else {
        dColor = WALL_DELINEATE_PALETTE[hashString(name || String(eid)) % WALL_DELINEATE_PALETTE.length];
      }
      nextDelineate.set(eid, dColor);

      // 2. ZONE / STOREY MODE COLOR
      let zColor: Rgba;
      if (ifcType === 'IfcPlate' || lower.includes('glazing')) {
        zColor = [0.48, 0.86, 0.98, 0.36];
      } else if (
        lower.includes('stair') ||
        lower.includes('baluster') ||
        lower.includes('balustrade') ||
        lower.includes('newel') ||
        lower.includes('stringer') ||
        lower.includes('landing')
      ) {
        zColor = [0.98, 0.52, 0.12, 1.0]; // Circulation / Stairwell Zone - Vivid Orange-Gold
      } else if (ifcType === 'IfcRoof' || lower.includes('roof') || lower.includes('fascia') || lower.includes('rake')) {
        zColor = [0.36, 0.48, 0.64, 1.0]; // Roof Zone - Steel Blue
      } else if (lower.includes('basement') || lower.includes('foundation') || lower.includes('storage divider') || storeyName.includes('basement')) {
        zColor = [0.64, 0.48, 0.86, 1.0]; // Basement Zone - Amethyst Purple
      } else if (lower.includes('upper') || lower.includes('-u1') || storeyName.includes('upper')) {
        zColor = [0.16, 0.78, 0.54, 1.0]; // Upper Level Zone - Vivid Emerald
      } else if (lower.includes('apartment a') || lower.includes('front') || lower.includes('porch') || lower.includes('s-w') || lower.includes('s-d')) {
        zColor = [0.94, 0.34, 0.32, 1.0]; // Apartment A / South Front Zone - Warm Coral Red
      } else if (lower.includes('apartment b') || lower.includes('back wing') || lower.includes('w-d') || lower.includes('w-w') || lower.includes('n-w') || lower.includes('e-d')) {
        zColor = [0.14, 0.66, 0.92, 1.0]; // Apartment B / North-West Zone - Cerulean Blue
      } else {
        zColor = [0.22, 0.74, 0.78, 1.0]; // Main Level Shared / Perimeter - Teal
      }
      nextZone.set(eid, zColor);
    }
  }

  if (nextDelineate.size > 0) delineateColors = nextDelineate;
  if (nextZone.size > 0) zoneColors = nextZone;
}

function getActiveColorMap(targetMode: IfcxColorMode): Map<number, Rgba> {
  if (delineateColors.size === 0 || zoneColors.size === 0) {
    computeDelineateAndZoneColorsFromStore();
  }
  switch (targetMode) {
    case 'delineate':
      return delineateColors;
    case 'zone':
      return zoneColors;
    case 'layer':
      return layerColors;
    case 'material':
    default:
      return materialColors;
  }
}

function emit() {
  const count = Math.max(layerColors.size, delineateColors.size, materialColors.size);
  snapshot = { mode, count };
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
  store.setPendingColorUpdates(nextMode === 'material' ? new Map() : new Map(activeMap));
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
  computeDelineateAndZoneColorsFromStore();
  applyColorsToStoreModels(getActiveColorMap(mode), mode);
  emit();
}

export function setIfcxColorMode(next: IfcxColorMode) {
  mode = next;
  computeDelineateAndZoneColorsFromStore();
  applyColorsToStoreModels(getActiveColorMap(next), next);
  emit();
}

if (typeof window !== 'undefined') {
  // On HMR or initial script evaluation, if models are already in the store, populate and apply immediately
  setTimeout(() => {
    const store = useViewerStore.getState();
    if (store.models.size > 0) {
      computeDelineateAndZoneColorsFromStore();
      applyColorsToStoreModels(getActiveColorMap(mode), mode);
      emit();
    }
  }, 50);

  (window as unknown as Record<string, unknown>).__MARPA_IFCX_COLOR_MODE__ = {
    getState: getIfcxColorModeState,
    setMode: setIfcxColorMode,
    getLayerColors: () => Object.fromEntries(layerColors),
    getMaterialColors: () => Object.fromEntries(materialColors),
    getDelineateColors: () => Object.fromEntries(delineateColors),
    getZoneColors: () => Object.fromEntries(zoneColors),
  };
}


