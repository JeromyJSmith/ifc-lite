/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for multi-model federation operations
 * Handles addModel, removeModel, ID offset management, RTC alignment,
 * IFCX federated layer composition, and legacy model migration
 *
 * Extracted from useIfc.ts for better separation of concerns
 */

import { assertWorkflowOwner } from '@/lib/flow/run-session';
import type { ModelLoadOptions, FederationAddModelOptions } from './modelLoadOptions.js';
import { commitRealignmentFrame } from '@/lib/model-placement/realignment-frame';
import { useCallback, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore, type FederatedModel } from '../store/index.js';
import { layerStackEntry } from '../lib/layers/stack.js';
import { detectFormat, parseFederatedIfcx, type IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { chooseSharedRtcOffset } from '@ifc-lite/geometry/world-frame';
import { IfcQuery } from '@ifc-lite/query';
import { calculateMeshBounds, createCoordinateInfo } from '../utils/localParsingUtils.js';
import { buildIfcxDataStore, convertIfcxMeshes } from './ingest/viewerModelIngest.js';
import { extractModelSpatialPlacement, findReferenceSpatialModel } from './ingest/federationAlign.js';
import { realignFederationModels } from './ingest/federationRealign.js';
import { withModelRotationsUnbaked } from '../components/viewer/useModelRotationSync.js';
import { convergeFederationRtcFrame } from './ingest/federationRtcRebase.js';
import { toast } from '../components/ui/toast.js';
import { acquireFederationLoadSlot, releaseFederationLoadSlot } from './federationLoadGate.js';
import { realignFederatedPointClouds } from './ingest/pointCloudFederationLifecycle.js';
import { showLoadError } from '@/lib/analytics';

/**
 * Extended data store type for IFCX (IFC5) files.
 * IFCX uses schemaVersion 'IFC5' and may include federated composition metadata.
 */
export interface IfcxDataStore extends IfcDataStore {
  schemaVersion: 'IFC5';
  /** Federated layer info for re-composition */
  _federatedLayers?: Array<{ id: string; name: string; enabled: boolean }>;
  /** Original buffers for re-composition when adding overlays */
  _federatedBuffers?: Array<{ buffer: ArrayBuffer; name: string }>;
  /** Composition statistics */
  _compositionStats?: { layersUsed: number; inheritanceResolutions: number; crossLayerReferences: number };
  /** Layer info for display */
  _layerInfo?: Array<{ id: string; name: string; meshCount: number; colorHex?: string }>;
  /** Map from expressId to the winning IFCX source layer and path */
  _entitySourceLayer?: Map<number, { layerId: string; layerName: string; colorHex: string; path: string }>;
}

const IFCX_LAYER_COLOR_PALETTE: ReadonlyArray<{ hex: string; rgba: [number, number, number, number] }> = [
  { hex: '#64748b', rgba: [0x64 / 255, 0x74 / 255, 0x8b / 255, 1.0] },
  { hex: '#0ea5e9', rgba: [0x0e / 255, 0xa5 / 255, 0xe9 / 255, 1.0] },
  { hex: '#f59e0b', rgba: [0xf5 / 255, 0x9e / 255, 0x0b / 255, 1.0] },
  { hex: '#10b981', rgba: [0x10 / 255, 0xb9 / 255, 0x81 / 255, 1.0] },
  { hex: '#8b5cf6', rgba: [0x8b / 255, 0x5c / 255, 0xf6 / 255, 1.0] },
  { hex: '#ec4899', rgba: [0xec / 255, 0x48 / 255, 0x99 / 255, 1.0] },
  { hex: '#14b8a6', rgba: [0x14 / 255, 0xb8 / 255, 0xa6 / 255, 1.0] },
  { hex: '#f97316', rgba: [0xf9 / 255, 0x73 / 255, 0x16 / 255, 1.0] },
  { hex: '#84cc16', rgba: [0x84 / 255, 0xcc / 255, 0x16 / 255, 1.0] },
  { hex: '#06b6d4', rgba: [0x06 / 255, 0xb6 / 255, 0xd4 / 255, 1.0] },
  { hex: '#e11d48', rgba: [0xe1 / 255, 0x1d / 255, 0x48 / 255, 1.0] },
  { hex: '#6366f1', rgba: [0x63 / 255, 0x66 / 255, 0xf1 / 255, 1.0] },
  { hex: '#d97706', rgba: [0xd9 / 255, 0x77 / 255, 0x06 / 255, 1.0] },
  { hex: '#059669', rgba: [0x05 / 255, 0x96 / 255, 0x69 / 255, 1.0] },
];

/**
 * Hook providing multi-model federation operations
 * Includes addModel, removeModel, federated IFCX loading, overlay management,
 * and ID resolution helpers
 */
export function useIfcFederation(
  // The ONE canonical loader. Federated adds route through it (target
  // 'federated') so model #1 and model #N share an identical pipeline.
  loadFile: (
    file: File,
    target?: import('./useIfcLoader.js').LoadTarget,
    options?: ModelLoadOptions,
  ) => Promise<void>,
) {
  const {
    setLoading,
    setError,
    setProgress,
    setIfcDataStore,
    setGeometryResult,
    // Multi-model state and actions
    addModel: storeAddModel,
    removeModel: storeRemoveModel,
    clearAllModels,
    getModel,
    // Federation Registry helpers
    fromGlobalId,
    findModelForGlobalId,
    resolveGlobalIdFromModels,
  } = useViewerStore(useShallow((s) => ({
    setLoading: s.setLoading,
    setError: s.setError,
    setProgress: s.setProgress,
    setIfcDataStore: s.setIfcDataStore,
    setGeometryResult: s.setGeometryResult,
    addModel: s.addModel,
    removeModel: s.removeModel,
    clearAllModels: s.clearAllModels,
    getModel: s.getModel,
    fromGlobalId: s.fromGlobalId,
    findModelForGlobalId: s.findModelForGlobalId,
    resolveGlobalIdFromModels: s.resolveGlobalIdFromModels,
  })));

  // Per-call ownership token. Each addModel() bumps this; state writes
  // (loading/error/progress) in the catch block must compare back to
  // their captured value before mutating, so a cancelled load A doesn't
  // overwrite progress for a newer load B that started after A's abort.
  // Mirrors the same pattern in useIfcLoader.ts.
  const loadSessionRef = useRef(0), realignSessionRef = useRef(0);

  const reportError = (message: string, code: string, retry: (() => void) | null) => // #5851: retry required
    showLoadError(setError, useViewerStore.getState().setLastLoadRetry, message, code, retry);

  /**
   * Add a model to the federation (multi-model support)
   * Uses FederationRegistry to assign unique ID offsets - BULLETPROOF against ID collisions
   * Returns the model ID on success, null on failure
   */
  const addModel = useCallback(async (
    file: File,
    options?: FederationAddModelOptions
  ): Promise<string | null> => {
    assertWorkflowOwner(options?.workflowOwner);
    const modelId = options?.modelId ?? crypto.randomUUID();
    // Request order, not completion order, decides the RTC anchor of overlapping loads (#4897).
    const loadedAt = options?.loadedAt ?? Date.now();
    const addStart = performance.now();
    // Bump the per-call ownership token first so that any error path
    // (including the load gate) can compare against this captured value
    // before mutating shared loading/error/progress state.
    const currentSession = ++loadSessionRef.current;
    // Memory-aware load gate: if a previous federation load is still in
    // flight on this tab and admitting this one would exceed the device
    // memory budget, wait until headroom frees. Single-file loads never
    // wait. See `federationLoadGate.ts` for the budget formula. (#600)
    const fileSizeForGateMB = (typeof (file as File).size === 'number' ? (file as File).size : 0) / (1024 * 1024);
    const gateSlot = await acquireFederationLoadSlot(fileSizeForGateMB);
    try {
      // (Removed the legacy→Map migration: every model — including model #1 —
      // now registers in the FederationRegistry + models Map via loadFile's
      // upsertModel/finalizeModel, so a top-level-only "legacy" model can no
      // longer exist. See PR description for the audit.)
      setLoading(true);
      setError(null);
      setProgress({ phase: 'Loading file', percent: 0 });

      // Shared RTC origin: earliest existing model with a real anchor, or
      // `undefined` if none has one yet; the convergence after the load makes
      // THAT case order-independent too (#4897).
      const sharedRtcOffset = chooseSharedRtcOffset(useViewerStore.getState().models.values() as Iterable<FederatedModel>);

      // THE canonical load path. loadFile acquires bytes, detects format
      // (IFC / IFCX / GLB / point cloud), produces geometry through the single
      // GeometryProcessor pipeline, parses the data store, and — because the
      // target is federated — finalizeModel aligns to the anchor, offsets ids,
      // builds the spatial index, and registers the model via addModel. loadFile
      // awaits that finalize, so on return the model is already in the map.
      await loadFile(file, {
        kind: 'federated',
        modelId,
        name: options?.name,
        visible: options?.visible,
        collapsed: options?.collapsed,
        loadedAt,
        sharedRtcOffset,
      }, { sourceHandle: options?.sourceHandle, workflowOwner: options?.workflowOwner });

      // Before the session check: a superseded load still settled a model (#4897, `federationRtcRebase.ts`).
      if (useViewerStore.getState().models.has(modelId)) convergeFederationRtcFrame();
      if (loadSessionRef.current !== currentSession) return null;
      const registered = useViewerStore.getState().models.has(modelId);
      if (registered) {
        console.log(`[ifc-lite] Added model ${file.name} (${fileSizeForGateMB.toFixed(1)}MB) in ${(performance.now() - addStart).toFixed(0)}ms`);
      }
      return registered ? modelId : null;

    } catch (err) {
      // Only mutate shared loading/error/progress state if our session
      // is still the active one. A second addModel() that started after
      // we were cancelled has already taken over the spinner — we must
      // not overwrite it with our "Cancelled" state.
      const isCurrent = loadSessionRef.current === currentSession;
      // User-initiated cancel surfaces as an AbortError. Map it to a
      // benign "Cancelled" state so the federated path matches the
      // single-model loader rather than reporting a parse failure.
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.log('[useIfc] addModel cancelled by user');
        if (isCurrent) {
          setError(null);
          setProgress({ phase: 'Cancelled', percent: 0 });
          setLoading(false);
        }
        return null;
      }
      console.error('[useIfc] addModel failed:', err);
      if (isCurrent) {
        reportError(err instanceof Error ? err.message : 'Unknown error', 'federated_add_failed',
          () => { void addModel(file, options); });
        setLoading(false);
      }
      return null;
    } finally {
      releaseFederationLoadSlot(gateSlot);
    }
  }, [loadFile, setLoading, setError, setProgress]);

  /**
   * Re-apply federation alignment using the currently selected anchor
   * (`anchorModelIdOverride` from the store, falling back to earliest-loaded).
   *
   * Restores every model's geometry from its pre-alignment snapshot — the
   * anchor included, because it may have been aligned under a previous anchor
   * (#2007) — then re-runs alignment on the non-anchors. Models with no
   * geometry or no georeference are left in their own frame and counted as
   * skipped. Updates `federationAlignmentStatus` on every touched model so the
   * UI badges reflect the new state.
   *
   * The mechanics live in `ingest/federationRealign.ts`; what stays here is the
   * store and toast wiring.
   *
   * Per user preference: this is an explicit operation, not auto-triggered by
   * remove/reorder/anchor-change. Wire it to a "Re-align federation" button.
   */
  const realignFederation = useCallback(async (): Promise<void> => {
    const realignSession = ++realignSessionRef.current;
    const state = useViewerStore.getState();
    if (state.models.size === 0) { toast.info('No models loaded — nothing to re-align.'); return; }

    const referenceSelection = findReferenceSpatialModel();
    if (!referenceSelection) {
      realignFederatedPointClouds(null);
      toast.error('Cannot re-align: no model with valid georeferencing.');
      return;
    }
    // Snapshot edits: an awaited cross-CRS pass must never mix old and new frames.
    const georefMutations = state.georefMutations;
    const selectedAnchor = state.models.get(referenceSelection.modelId);
    if (!selectedAnchor) return;
    state.closeReposition();
    // Keep rotations outside preAlignment; useModelRotationSync reapplies headings once.
    const { counts, anchorGeoref, movedModelIds, stale } = await withModelRotationsUnbaked(() => realignFederationModels({
      models: () => Array.from(useViewerStore.getState().models.entries()) as Array<[string, FederatedModel]>,
      getModel: (modelId) => useViewerStore.getState().models.get(modelId),
      anchorModelId: referenceSelection.modelId,
      anchorModel: selectedAnchor,
      anchorGeoref: referenceSelection.placement,
      resolveGeoref: (modelId, model) => (
        model.geometryResult && model.spatialReference
          ? { spatialReference: model.spatialReference, coordinateInfo: model.geometryResult.coordinateInfo }
          : model.ifcDataStore && model.geometryResult
            ? extractModelSpatialPlacement(
            model.ifcDataStore,
            model.geometryResult.coordinateInfo,
            georefMutations.get(modelId),
          )
          : null
      ),
      updateModel: state.updateModel,
      isCurrent: () => realignSession === realignSessionRef.current,
    }));
    if (stale || realignSession !== realignSessionRef.current) return; // Stale rollback must not publish frame/index/scan work.
    // Manual offsets remain explicit workspace vectors after re-alignment.
    // Picked anchors were cancelled above; exchange files must name the new frame.
    const frameCommitted = commitRealignmentFrame(state.models, anchorGeoref);

    // Everything keyed on "whose geometry actually moved", not on the align
    // count — a restored anchor (#2007) and a restored-then-skipped model both
    // move without being aligned.
    if (movedModelIds.length > 0) {
      // Signal that mesh content was mutated in place — forces the merged-mesh
      // cache in ViewportContainer to rebuild AND the streaming hook to clear
      // the WebGPU scene and re-upload buffers. Without this, the success toast
      // fires but the visible model doesn't move because the GPU still has the
      // old vertex positions cached.
      useViewerStore.getState().bumpGeometryContentVersion();

      // The placement index sync observes the content revision and rebuilds
      // from placed flat meshes plus any uploaded instances.
      const models = useViewerStore.getState().models;
      for (const modelId of movedModelIds) {
        const moved = models.get(modelId) as FederatedModel | undefined;
        if (moved?.ifcDataStore && moved.geometryResult) {
          useViewerStore.getState().updateModel(modelId, {});
        }
      }
    }

    realignFederatedPointClouds(findReferenceSpatialModel()?.placement ?? null);

    if (!frameCommitted) return; // Surviving geometry still needed the invalidation above.
    const messageParts: string[] = [];
    if (counts.aligned > 0) messageParts.push(`${counts.aligned} aligned`);
    if (counts.reprojected > 0) messageParts.push(`${counts.reprojected} reprojected`);
    if (counts.skipped > 0) messageParts.push(`${counts.skipped} skipped`);
    if (counts.failed > 0) messageParts.push(`${counts.failed} failed`);
    const summary = messageParts.length > 0 ? messageParts.join(', ') : 'no changes needed';
    if (counts.failed > 0) {
      toast.error(`Federation re-aligned against "${anchorGeoref.spatialReference.horizontal?.id ?? 'unknown CRS'}": ${summary}.`);
    } else {
      toast.success(`Federation re-aligned against "${anchorGeoref.spatialReference.horizontal?.id ?? 'unknown CRS'}": ${summary}.`);
    }
  }, []);

  /**
   * Remove a model from the federation
   */
  const removeModel = useCallback((modelId: string) => {
    storeRemoveModel(modelId);

    // Read fresh state from store after removal to avoid stale closure
    const freshModels = useViewerStore.getState().models;
    const remaining = Array.from(freshModels.values()) as FederatedModel[];
    if (remaining.length > 0) {
      const newActive = remaining[0];
      setIfcDataStore(newActive.ifcDataStore);
      setGeometryResult(newActive.geometryResult);
    } else {
      setIfcDataStore(null);
      setGeometryResult(null);
    }
    realignFederatedPointClouds(findReferenceSpatialModel()?.placement ?? null);
  }, [storeRemoveModel, setIfcDataStore, setGeometryResult]);

  /**
   * Get query instance for a specific model
   */
  const getQueryForModel = useCallback((modelId: string): IfcQuery | null => {
    const model = getModel(modelId);
    if (!model || !model.ifcDataStore) return null;
    return new IfcQuery(model.ifcDataStore);
  }, [getModel]);

  /**
   * Load multiple files sequentially (WASM parser isn't thread-safe)
   * Each file fully loads before the next one starts
   */
  const loadFilesSequentially = useCallback(async (
    files: File[],
    handles?: (FileSystemFileHandle | undefined)[],
  ): Promise<void> => {
    for (let i = 0; i < files.length; i++) {
      await addModel(files[i], { sourceHandle: handles?.[i] });
    }
  }, [addModel]);

  /**
   * Load multiple IFCX files as federated layers
   * Uses IFC5's layer composition system where later files override earlier ones.
   * Properties from overlay files are merged with the base file(s).
   *
   * @param files - Array of IFCX files (first = base/weakest, last = strongest overlay)
   *
   * @example
   * ```typescript
   * // Load base model with property overlay
   * await loadFederatedIfcx([
   *   baseFile,           // hello-wall.ifcx
   *   fireRatingFile,     // add-fire-rating.ifcx (adds FireRating property)
   * ]);
   * ```
   */
  /**
   * Internal: Load federated IFCX from buffers (used by both initial load and add overlay)
   */
  const loadFederatedIfcxFromBuffers = useCallback(async (
    buffers: Array<{ buffer: ArrayBuffer; name: string }>,
  ): Promise<void> => {
    const { resetViewerState, clearAllModels } = useViewerStore.getState();

    try {
      // Reset viewer state on EVERY federated (re-)composition, including
      // overlay-add. This used to be gated by a boolean "preserve state"
      // option that was declared but never read (dead since #193) -
      // `addIfcxOverlays` opted out believing it preserved selection,
      // but the reset always ran anyway. Investigation confirmed the
      // reset is correct, not just accidentally-always-on: expressIds in
      // the composed IFCX entity table are synthetic and reassigned by
      // iteration order over the composed node map, which shifts when a
      // new overlay becomes the strongest layer - even a pure
      // property-only overlay that adds no entities can reshuffle which
      // expressId belongs to which entity. Since federated models share
      // idOffset 0 (globalId === expressId), a selection/hidden/isolated
      // set captured before recomposition can silently point at a
      // DIFFERENT entity afterwards if left un-reset. So this reset is
      // unconditional and there is no "preserve state" option to honour.
      resetViewerState();

      // Clear legacy geometry BEFORE clearing models to prevent stale fallback
      // This avoids a race condition where mergedGeometryResult uses old geometry
      // during the brief moment when storeModels.size === 0
      setGeometryResult(null);
      clearAllModels();

      setLoading(true);
      setError(null);
      setProgress({ phase: 'Parsing federated IFCX', percent: 0 });

      // Parse federated IFCX files
      const result = await parseFederatedIfcx(buffers, {
        onProgress: (prog: { phase: string; percent: number }) => {
          setProgress({ phase: `IFCX ${prog.phase}`, percent: prog.percent });
        },
      });

      // Convert IFCX meshes to viewer format
      const meshes: MeshData[] = convertIfcxMeshes(result.meshes);

      // Calculate bounds
      const { bounds, stats } = calculateMeshBounds(meshes);
      const coordinateInfo = createCoordinateInfo(bounds);

      const geometryResult = {
        meshes,
        totalVertices: stats.totalVertices,
        totalTriangles: stats.totalTriangles,
        coordinateInfo,
      };

      // NOTE: Do NOT call setGeometryResult() here!
      // For federated loading, geometry comes from the models Map via mergedGeometryResult.
      // Calling setGeometryResult() before models are added causes a race condition where
      // meshes are added to the scene WITHOUT modelIndex, breaking selection highlighting.

      // Get layer info with mesh counts
      // getLayers() is strongest-first; composition order (weakest first) is reversed.
      const layers = result.layerStack.getLayers();
      const layerColorById = new Map<string, { hex: string; rgba: [number, number, number, number]; name: string }>();
      for (let i = 0; i < layers.length; i++) {
        const compIdx = layers.length - 1 - i; // 0 = base layer, N-1 = strongest fix layer
        const paletteEntry = IFCX_LAYER_COLOR_PALETTE[compIdx % IFCX_LAYER_COLOR_PALETTE.length];
        layerColorById.set(layers[i].id, {
          hex: paletteEntry.hex,
          rgba: paletteEntry.rgba,
          name: layers[i].name,
        });
      }

      const fallbackLayer = layers[layers.length - 1];
      const entitySourceLayer = new Map<number, { layerId: string; layerName: string; colorHex: string; path: string }>();
      if (result.pathToId && result.pathToLayers) {
        for (const [path, expressId] of result.pathToId.entries()) {
          const contributingLayers = result.pathToLayers.get(path);
          const winningLayerId = contributingLayers && contributingLayers.length > 0
            ? contributingLayers[contributingLayers.length - 1]
            : fallbackLayer?.id ?? 'layer_0';
          const colorInfo = layerColorById.get(winningLayerId) ?? {
            hex: IFCX_LAYER_COLOR_PALETTE[0].hex,
            rgba: IFCX_LAYER_COLOR_PALETTE[0].rgba,
            name: fallbackLayer?.name ?? winningLayerId,
          };
          entitySourceLayer.set(expressId, {
            layerId: winningLayerId,
            layerName: colorInfo.name,
            colorHex: colorInfo.hex,
            path,
          });
        }
      }

      // Partition meshes by winning source layer and color each mesh by its layer
      const meshesByLayerId = new Map<string, MeshData[]>();
      for (const layer of layers) {
        meshesByLayerId.set(layer.id, []);
      }
      for (const mesh of meshes) {
        const path = result.idToPath?.get(mesh.expressId);
        const contributingLayers = path ? result.pathToLayers?.get(path) : undefined;
        const winningLayerId = contributingLayers && contributingLayers.length > 0
          ? contributingLayers[contributingLayers.length - 1]
          : fallbackLayer?.id ?? layers[0]?.id;
        const colorInfo = winningLayerId ? layerColorById.get(winningLayerId) : undefined;
        if (colorInfo) {
          mesh.color = [...colorInfo.rgba];
          if (path && !entitySourceLayer.has(mesh.expressId)) {
            entitySourceLayer.set(mesh.expressId, {
              layerId: winningLayerId!,
              layerName: colorInfo.name,
              colorHex: colorInfo.hex,
              path,
            });
          }
        }
        const bucket = (winningLayerId && meshesByLayerId.get(winningLayerId)) ?? meshesByLayerId.get(fallbackLayer.id);
        if (bucket) {
          bucket.push(mesh);
        }
      }

      // Create data store from federated result. Route through the shared
      // IFCX store factory so the lazy accessors (getEntity/getProperties/
      // getQuantities) the query + mutation paths call exist — without
      // them, selecting or editing an entity in a federated model threw
      // "this.store.getProperties is not a function" (#1717 V2).
      const accessorStore = buildIfcxDataStore(result, buffers[0].buffer);
      const dataStore = Object.assign(accessorStore, {
        // Federated-specific: store layer info and ORIGINAL BUFFERS for re-composition
        _federatedLayers: layers.map((l: { id: string; name: string; enabled: boolean }) => ({
          id: l.id,
          name: l.name,
          enabled: l.enabled,
        })),
        _federatedBuffers: buffers.map(b => ({
          buffer: b.buffer.slice(0), // Clone buffer
          name: b.name,
        })),
        _compositionStats: result.compositionStats,
        _layerInfo: layers.map((l: { id: string; name: string }) => ({
          id: l.id,
          name: l.name,
          meshCount: meshesByLayerId.get(l.id)?.length ?? 0,
          colorHex: layerColorById.get(l.id)?.hex,
        })),
        _entitySourceLayer: entitySourceLayer,
      }) as unknown as IfcxDataStore;

      // IfcxDataStore extends IfcDataStore (with schemaVersion: 'IFC5'), so this is safe
      setIfcDataStore(dataStore);

      const enrichedPathToId = result.pathToId ? new Map<string, number>(result.pathToId) : null;
      if (enrichedPathToId && dataStore.entities) {
        const nameToId = new Map<string, number>();
        for (const [, expressId] of result.pathToId!.entries()) {
          const entName = dataStore.entities.getName(expressId)?.trim();
          if (entName && !enrichedPathToId.has(entName)) {
            enrichedPathToId.set(entName, expressId);
            nameToId.set(entName, expressId);
          }
          const storeyId = dataStore.spatialHierarchy?.elementToStorey?.get(expressId);
          const storeyName = storeyId ? dataStore.entities.getName(storeyId)?.trim() : undefined;
          if (storeyName && entName) {
            const rel = `${storeyName}/${entName}`;
            if (!enrichedPathToId.has(rel)) enrichedPathToId.set(rel, expressId);
          }
        }
        const canonicalAliases: Array<[string, string]> = [
          ['Project_401Pearl/Site_401Pearl/Building_401Pearl/Storey_Level2/Roof_Gable_N_Slope_W_r3', 'Upper level walls'],
          ['Project_401Pearl/Site_401Pearl/Building_401Pearl/Storey_Level1/Wall_EXT_W_L1_SouthSeg', 'Stairwell south wall (exterior)'],
          ['Project_401Pearl/Site_401Pearl/Building_401Pearl/Storey_Level1/Stair_Main_1/StairFlight_1', 'Lower flight (straight, bullnose start)'],
        ];
        for (const [alias, targetName] of canonicalAliases) {
          const targetId = nameToId.get(targetName);
          if (targetId !== undefined && !enrichedPathToId.has(alias)) {
            enrichedPathToId.set(alias, targetId);
          }
        }
      }

      // Layers panel (#1717): expose the stack behind this composition.
      // getLayers() is strongest-first; the panel slice keeps composition
      // order (weakest first). The parser retains each parsed IfcxFile, so
      // entries reference them without re-parsing.
      useViewerStore.getState().setLayerStack(
        [...layers].reverse().map((layer) => ({
          ...layerStackEntry(layer),
          colorHex: layerColorById.get(layer.id)?.hex,
          meshCount: meshesByLayerId.get(layer.id)?.length ?? 0,
        })),
        enrichedPathToId,
      );
      if (layers.length >= 2) {
        useViewerStore.getState().openWorkspacePanel('layers', 'programmatic');
        useViewerStore.getState().setSidebarSecondaryPanel('properties');
        useViewerStore.getState().setSidebarSplitRatio(0.42);
      }

      // Find max expressId for proper ID range tracking
      // This is needed for resolveGlobalIdFromModels and subsequent addModel calls
      let maxExpressId = 0;
      if (result.entities?.expressId) {
        // @raw-entity-enumeration-ok load-time ID watermark scans the newly composed IFCX table before any session overlay is installed
        for (let i = 0; i < result.entities.count; i++) {
          const id = result.entities.expressId[i];
          if (id > maxExpressId) maxExpressId = id;
        }
      }
      if (fallbackLayer) {
        useViewerStore.getState().registerModelOffset(fallbackLayer.id, maxExpressId);
      }

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const layerBuffer = buffers.find(b => b.name === layer.name);
        const isBaseLayer = i === layers.length - 1; // Last layer (weakest) is base
        const layerMeshes = meshesByLayerId.get(layer.id) ?? [];
        let layerVertices = 0;
        let layerTriangles = 0;
        for (const m of layerMeshes) {
          layerVertices += m.positions.length / 3;
          layerTriangles += m.indices.length / 3;
        }

        const layerModel: FederatedModel = {
          id: layer.id,
          name: layer.name,
          ifcDataStore: dataStore, // Share the composed data store
          geometryResult: {
            meshes: layerMeshes,
            totalVertices: layerVertices,
            totalTriangles: layerTriangles,
            coordinateInfo,
          },
          visible: true,
          collapsed: i > 0, // Collapse overlays by default
          schemaVersion: 'IFC5',
          loadedAt: Date.now() - (layers.length - i) * 100, // Stagger timestamps
          fileSize: layerBuffer?.buffer.byteLength || 0,
          // For base layer: set proper ID range for resolveGlobalIdFromModels
          // Overlays share the same data store so they don't need their own range
          idOffset: 0,
          maxExpressId: isBaseLayer ? maxExpressId : 0,
          // Mark overlay-only layers
          _isOverlay: !isBaseLayer,
          _layerIndex: i,
        } as FederatedModel & { _isOverlay?: boolean; _layerIndex?: number };

        storeAddModel(layerModel);
      }
      if (fallbackLayer) {
        useViewerStore.getState().setActiveModel(fallbackLayer.id);
      }

      setProgress({ phase: 'Complete', percent: 100 });
      setLoading(false);
    } catch (err: unknown) {
      console.error('[useIfc] Federated IFCX loading failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      reportError(`Federated IFCX loading failed: ${message}`, 'ifcx_federated_load_failed',
        () => { void loadFederatedIfcxFromBuffers(buffers); }); // retry re-composes the same buffers
      setLoading(false);
    }
  }, [setLoading, setProgress, setGeometryResult, setIfcDataStore, storeAddModel, clearAllModels]);

  const loadFederatedIfcx = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) {
      reportError('No files provided for federated loading', 'ifcx_federated_no_files', null); // no retry: empty list
      return;
    }

    // Check that all files are IFCX format and read buffers.
    // IFCX is JSON; SAB streaming would force a SAB→scratch copy in
    // safeUtf8Decode on top of the JSON string (net worse peak than
    // ArrayBuffer). Keep on file.arrayBuffer(). The copy is no longer
    // *retained* since #2183 capped the scratch, but it is still a
    // full-file transient the ArrayBuffer path does not pay.
    const buffers: Array<{ buffer: ArrayBuffer; name: string }> = [];
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const format = detectFormat(buffer);
      if (format !== 'ifcx') {
        reportError(`File "${file.name}" is not an IFCX file. Federated loading only supports IFCX files.`, 'ifcx_federated_not_ifcx', null); // no retry: still not IFCX
        return;
      }
      buffers.push({ buffer, name: file.name });
    }

    await loadFederatedIfcxFromBuffers(buffers);
  }, [loadFederatedIfcxFromBuffers]);

  /**
   * Add IFCX overlay files to existing federated model
   * Re-composes all layers including new overlays
   * Also handles adding overlays to a single IFCX file that wasn't loaded via federated loading
   */
  const addIfcxOverlays = useCallback(async (files: File[]): Promise<void> => {
    const currentStore = useViewerStore.getState().ifcDataStore as IfcxDataStore | null;
    const currentModels = useViewerStore.getState().models;

    // Get existing buffers - either from federated loading or from single file load
    let existingBuffers: Array<{ buffer: ArrayBuffer; name: string }> = [];

    if (currentStore?._federatedBuffers) {
      // Already federated - use stored buffers
      existingBuffers = currentStore._federatedBuffers as Array<{ buffer: ArrayBuffer; name: string }>;
    } else if (currentStore?.source && currentStore.schemaVersion === 'IFC5') {
      // Single IFCX file loaded via loadFile() - reconstruct buffer from source
      // Get the model name from the models map
      let modelName = 'base.ifcx';
      for (const [, model] of currentModels) {
        // Compare object identity (cast needed due to IFC5 schema extension)
        if ((model.ifcDataStore as unknown) === currentStore || model.schemaVersion === 'IFC5') {
          modelName = model.name;
          break;
        }
      }

      // Whole-file consumer: the IFCX re-composition needs its own
      // ArrayBuffer, so copy out of the source rather than aliasing it.
      const sourceBuffer = currentStore.source
        .withMaterialized((bytes) => bytes.slice().buffer) as ArrayBuffer;

      existingBuffers = [{ buffer: sourceBuffer, name: modelName }];
    } else {
      reportError('Cannot add overlays: no IFCX model loaded', 'ifcx_overlay_no_base',
        () => { void addIfcxOverlays(files); }); // a base model may load before a retry
      return;
    }

    // Read new overlay buffers.
    // IFCX is JSON; SAB streaming would force a SAB→scratch copy in
    // safeUtf8Decode on top of the JSON string (net worse peak than
    // ArrayBuffer). Keep on file.arrayBuffer(). The copy is no longer
    // *retained* since #2183 capped the scratch, but it is still a
    // full-file transient the ArrayBuffer path does not pay.
    const newBuffers: Array<{ buffer: ArrayBuffer; name: string }> = [];
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const format = detectFormat(buffer);
      if (format !== 'ifcx') {
        reportError(`File "${file.name}" is not an IFCX file.`, 'ifcx_overlay_not_ifcx', null); // no retry: still not IFCX
        return;
      }
      newBuffers.push({ buffer, name: file.name });
    }

    // Combine: existing layers first, new overlays LAST. parseFederatedIfcx
    // treats the first file as weakest and the last as strongest, so a new
    // overlay must trail the existing stack — leading it made every added
    // overlay the WEAKEST layer, silently shadowed by the model it was
    // meant to override (#1717 V2).
    const allBuffers = [...existingBuffers, ...newBuffers];

    // Re-composing (including this overlay add) always resets viewer
    // state - see loadFederatedIfcxFromBuffers for why: expressIds are
    // not stable across recomposition, so stale selection/hidden ids
    // could point at the wrong entity afterwards.
    await loadFederatedIfcxFromBuffers(allBuffers);
  }, [loadFederatedIfcxFromBuffers]);

  // Both resolvers below go through the store's canonical
  // `resolveGlobalIdFromModels` first, falling back to the `federationRegistry`
  // singleton only for a model that has left `state.models` but is still
  // registered. Consulting the registry alone missed every model seeded
  // without `registerModelOffset` — the federated-IFCX composition just above
  // does exactly that (the collab room did too until #4444, when its models
  // started registering like any added file). See `useZoneSelection.ts` for
  // the same delegation, and PR #2697 for the clash path.

  /**
   * Find which model contains a given globalId.
   * Returns the modelId, or null if no loaded or registered model owns it.
   */
  const findModelForEntity = useCallback((globalId: number): string | null => {
    return resolveGlobalIdFromModels(globalId)?.modelId ?? findModelForGlobalId(globalId);
  }, [resolveGlobalIdFromModels, findModelForGlobalId]);

  /**
   * Convert a globalId back to the original (modelId, expressId) pair
   * Use this when you need to look up properties in the IfcDataStore
   */
  const resolveGlobalId = useCallback((globalId: number): { modelId: string; expressId: number } | null => {
    return resolveGlobalIdFromModels(globalId) ?? fromGlobalId(globalId);
  }, [resolveGlobalIdFromModels, fromGlobalId]);

  return {
    addModel,
    removeModel,
    getQueryForModel,
    loadFilesSequentially,
    loadFederatedIfcx,
    addIfcxOverlays,
    findModelForEntity,
    resolveGlobalId,
    realignFederation,
  };
}

export default useIfcFederation;
