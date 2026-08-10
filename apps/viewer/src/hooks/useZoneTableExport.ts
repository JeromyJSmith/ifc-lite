/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CSV / Parquet export of the per-element × per-zone volume table (issue
 * #2508 item 3) — the store-facing collector for the pure builder in
 * `lib/zones/apportionment-table.ts`, shaped like `useZoneApportionment`:
 * gather from one store snapshot, hand pure data on.
 *
 * Reuses rather than reimplements, on both sides:
 *
 *  - The APPORTIONED numbers are read from the same cache entry the Lists
 *    columns and both panels read (`validEntry`), never recomputed — the
 *    export is a third reader of one result, so it cannot disagree with the
 *    screen. Elements the entry refused export their refusal, not a guess.
 *  - The CSV goes through the Lists export writer (`toCsv`: quoting, formula
 *    injection guard) and the Parquet bytes through `@ifc-lite/export`'s
 *    `columnsToParquet` (the BOS archive's own conversion).
 *  - Units and declared bases resolve exactly as the properties panel does:
 *    `declaredVolumeBases` over the occurrence-then-inherited quantity sets,
 *    values converted through `resolveQuantityDisplay` (file unit or the
 *    user's override) — the same numbers, the same rounding.
 */

import { RelationshipType } from '@ifc-lite/data';
import {
  extractProjectUnits,
  extractQuantitiesOnDemand,
  extractTypeQuantitiesOnDemand,
  ProjectUnits,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { columnsToParquet } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { toCsv } from '@/lib/lists/export/csv';
import { resolveQuantityDisplay, QUANTITY_TYPE_UNIT } from '@/lib/units/display';
import {
  buildZoneApportionmentTable,
  declaredVolumeBases,
  validEntry,
  withInheritedTypeQuantities,
  zoneTableExportModel,
  zoneTableParquetColumns,
  VOLUME_QUANTITY_TYPE,
  type QuantitySetLike,
  type ZoneApportionmentTable,
  type ZoneSet,
  type ZoneTableElementSource,
} from '@/lib/zones';
import { gatherProvedVolumes } from './useZoneApportionment.js';

/** Per-model context resolved once, not once per element. */
interface ModelContext {
  store: IfcDataStore;
  modelName: string;
  /** Declared VOLUMEUNIT scale to SI m³ (canonical resolver — never derived
   *  from the length unit). */
  volumeSiScale: number;
  toDisplayUnit: (m3: number) => number;
  unitSymbol: string;
}

function buildModelContext(
  store: IfcDataStore,
  modelName: string,
  overrides: Record<string, string>,
): ModelContext {
  const projectUnits = store.source?.length > 0
    ? extractProjectUnits(store.source, store.entityIndex)
    : ProjectUnits.empty();
  const unitType = QUANTITY_TYPE_UNIT[VOLUME_QUANTITY_TYPE]?.unitType ?? 'VOLUMEUNIT';
  const fileScale = projectUnits.resolvedForUnitType(unitType)?.siScale ?? 1;
  const scale = Number.isFinite(fileScale) && fileScale > 0 ? fileScale : 1;
  const toDisplayUnit = (m3: number): number => {
    const inFileUnit = m3 / scale;
    const display = resolveQuantityDisplay(inFileUnit, VOLUME_QUANTITY_TYPE, projectUnits, overrides);
    return display.converted ?? inFileUnit;
  };
  const unitSymbol = resolveQuantityDisplay(1, VOLUME_QUANTITY_TYPE, projectUnits, overrides).unit ?? '';
  return { store, modelName, volumeSiScale: scale, toDisplayUnit, unitSymbol };
}

/** The element's declared volume bases, resolved the way the properties panel
 *  resolves them: own quantity sets first, then those inherited from its
 *  `IfcTypeObject`, so the occurrence wins per basis (#1745/#1755). */
function declaredFor(ctx: ModelContext, expressId: number) {
  const usesOnDemand = !!ctx.store.onDemandQuantityMap && ctx.store.source?.length > 0;
  const own = (usesOnDemand
    ? extractQuantitiesOnDemand(ctx.store, expressId)
    : ctx.store.quantities?.getForEntity(expressId) ?? []) as QuantitySetLike[];
  const qsets = withInheritedTypeQuantities(
    own,
    ctx.store,
    expressId,
    RelationshipType.DefinesByType,
    (store, id) => extractTypeQuantitiesOnDemand(store as IfcDataStore, id)?.quantities as QuantitySetLike[] | undefined,
  );
  return declaredVolumeBases(qsets, ctx.volumeSiScale);
}

/**
 * Build the export table for `zoneSet` from the current store snapshot, or
 * `null` when there is no VALID apportionment entry for it — the export ships
 * what was computed, never a stale revision and never a background clip.
 */
export function gatherZoneApportionmentTable(zoneSet: ZoneSet): ZoneApportionmentTable | null {
  const state = useViewerStore.getState();
  const entry = validEntry(state.zoneApportionment, zoneSet);
  if (!entry) return null;

  const proved = gatherProvedVolumes();
  const overrides = state.unitDisplayOverrides;
  const contexts = new Map<string, ModelContext | null>();
  const contextFor = (modelId: string): ModelContext | null => {
    const cached = contexts.get(modelId);
    if (cached !== undefined) return cached;
    const model = state.models.get(modelId);
    const store = model?.ifcDataStore ?? state.ifcDataStore;
    const ctx = store ? buildModelContext(store, model?.name ?? '', overrides) : null;
    contexts.set(modelId, ctx);
    return ctx;
  };

  const elements: ZoneTableElementSource[] = [];
  for (const [globalId, record] of state.zoneAssignments) {
    const assignment = record[zoneSet.id];
    if (!assignment) continue;
    const ref = resolveEntityRef(globalId);
    const ctx = contextFor(ref.modelId);
    if (!ctx) continue;
    const provedVolume = proved.byGlobalId.get(globalId);
    elements.push({
      globalId,
      ifcGlobalId: ctx.store.entities.getGlobalId(ref.expressId) ?? '',
      name: ctx.store.entities.getName(ref.expressId) ?? '',
      className: ctx.store.entities.getTypeName(ref.expressId) ?? '',
      modelName: ctx.modelName,
      assignment,
      declared: declaredFor(ctx, ref.expressId),
      provedMeshVolumeM3: provedVolume !== undefined && !proved.rescaled.has(globalId) ? provedVolume : null,
      toDisplayUnit: ctx.toDisplayUnit,
      unitSymbol: ctx.unitSymbol,
    });
  }

  return buildZoneApportionmentTable(zoneSet, entry, elements);
}

function exportFilename(zoneSet: ZoneSet, extension: string): string {
  return `${sanitizeFilename(`${zoneSet.name} apportionment`, { fallback: 'zone-apportionment' })}.${extension}`;
}

/** Download the table as CSV. Returns false when there is nothing to export
 *  (no valid apportionment entry for the set). */
export function exportZoneApportionmentCsv(zoneSet: ZoneSet): boolean {
  const table = gatherZoneApportionmentTable(zoneSet);
  if (!table) return false;
  const model = zoneTableExportModel(table, `${zoneSet.name} apportionment`, new Date().toLocaleString());
  downloadBlob(new Blob([toCsv(model)], { type: 'text/csv;charset=utf-8;' }), exportFilename(zoneSet, 'csv'));
  return true;
}

/** Download the table as a single Parquet file. Returns false when there is
 *  nothing to export. */
export async function exportZoneApportionmentParquet(zoneSet: ZoneSet): Promise<boolean> {
  const table = gatherZoneApportionmentTable(zoneSet);
  if (!table) return false;
  const { columns, floatColumns } = zoneTableParquetColumns(table);
  const bytes = await columnsToParquet(columns as Record<string, unknown[]>, floatColumns);
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), exportFilename(zoneSet, 'parquet'));
  return true;
}
