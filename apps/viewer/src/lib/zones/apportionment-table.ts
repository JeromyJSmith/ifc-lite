/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-element × per-zone volume table (issue #2508 item 3) — the export
 * shape behind "CSV/Parquet export … which is the direct answer to 'manual
 * work in Excel'". Pure: the store-facing collector lives in
 * `hooks/useZoneTableExport.ts`; this module only turns one zone set's
 * apportionment + assignments into rows, so the contract is testable without
 * a renderer or a store.
 *
 * ## Row semantics
 *
 * - A **straddler with a computed split** appears once per zone it holds
 *   volume in, `Status = apportioned` — that duplication is the point of the
 *   table. When part of it lies outside every zone of the set, that remainder
 *   is one more row with an EMPTY zone, `Status = outside`, so a pivot over
 *   the CSV sums back to the element's whole (the issue's #1 invariant, made
 *   visible rather than implied).
 * - A **non-straddler** appears once with its home zone, `Status = whole`:
 *   v1's whole-element assignment, not a measured split — the status says
 *   which it was.
 * - An **element in no zone of the set** appears once with an empty zone,
 *   `Status = no-zone`, carrying its totals. Included rather than omitted:
 *   #2508 calls a total that quietly omits elements worse than one that says
 *   what it left out, and dropping these rows would make every per-zone pivot
 *   silently short.
 * - A **refused straddler** (`no-geometry` / `unproved-solid` /
 *   `rescaled-by-alignment`, see `apportionment-cache.ts`) appears once per
 *   touched zone with the refusal as its status and NO mesh numbers — the
 *   declared totals are file facts and still travel. A straddler the entry
 *   has never seen exports as `not-computed` the same way.
 *
 * ## Basis labelling
 *
 * Every volume column names its basis (`mesh` / `net` / `gross` /
 * `unqualified`, `volume-basis.ts`) in its header, and each declared basis
 * carries its source quantity's name in its own column — a bare number with
 * no basis is exactly the ambiguity #2515 refused to ship. Values are in the
 * panel-resolved display unit (the `Unit` column, per row, because federated
 * models can declare different units) and rounded to the same 4 fraction
 * digits the panel shows, so the export never disagrees with the screen.
 */

import type { ZoneApportionmentEntry, ApportionmentRefusal } from './apportionment-cache.js';
import type { ElementApportionment } from './apportionment.js';
import type { ZoneAssignment, ZoneSet } from './types.js';
import { allBasisBreakdowns, type BasisBreakdown, type DeclaredVolume, type VolumeBasis } from './volume-basis.js';
import type { CellValue } from '@ifc-lite/lists';
import type { ExportModel } from '../lists/export/model.js';

/** Why a row exists — measured split, whole-element assignment, remainder
 *  outside the set, unclassified, or a stated refusal. */
export type ZoneTableStatus =
  | 'apportioned'
  | 'outside'
  | 'whole'
  | 'no-zone'
  | 'not-computed'
  | ApportionmentRefusal;

export interface ZoneTableColumn {
  id: string;
  label: string;
  numeric: boolean;
}

/** Fixed column set, in export order. Labels carry the basis per #2515's
 *  convention (the basis lives in the column name, never in a tooltip). */
export const ZONE_TABLE_COLUMNS: readonly ZoneTableColumn[] = [
  { id: 'model', label: 'Model', numeric: false },
  { id: 'globalId', label: 'GlobalId', numeric: false },
  { id: 'name', label: 'Name', numeric: false },
  { id: 'class', label: 'Class', numeric: false },
  { id: 'zoneSet', label: 'Zone set', numeric: false },
  { id: 'zone', label: 'Zone', numeric: false },
  { id: 'zoneId', label: 'Zone id', numeric: false },
  { id: 'straddles', label: 'Straddles', numeric: false },
  { id: 'status', label: 'Status', numeric: false },
  { id: 'sharePct', label: 'Share of element (%)', numeric: true },
  { id: 'volMesh', label: 'Volume (mesh)', numeric: true },
  { id: 'totalMesh', label: 'Element total (mesh)', numeric: true },
  { id: 'volNet', label: 'Volume (net)', numeric: true },
  { id: 'totalNet', label: 'Element total (net)', numeric: true },
  { id: 'qtyNet', label: 'Net quantity', numeric: false },
  { id: 'volGross', label: 'Volume (gross)', numeric: true },
  { id: 'totalGross', label: 'Element total (gross)', numeric: true },
  { id: 'qtyGross', label: 'Gross quantity', numeric: false },
  { id: 'volUnqualified', label: 'Volume (unqualified)', numeric: true },
  { id: 'totalUnqualified', label: 'Element total (unqualified)', numeric: true },
  { id: 'qtyUnqualified', label: 'Unqualified quantity', numeric: false },
  { id: 'unit', label: 'Unit', numeric: false },
  { id: 'note', label: 'Note', numeric: false },
] as const;

export type ZoneTableCell = string | number | boolean | null;

export interface ZoneApportionmentTable {
  columns: readonly ZoneTableColumn[];
  /** One array per row, aligned with {@link ZONE_TABLE_COLUMNS}. */
  rows: ZoneTableCell[][];
}

/** Everything the builder needs about ONE element, pre-resolved by the
 *  store-facing collector so this module stays pure. */
export interface ZoneTableElementSource {
  /** Federated global id — the key `zoneAssignments` and the entry share. */
  globalId: number;
  /** The IFC `GlobalId` string. */
  ifcGlobalId: string;
  name: string;
  /** IFC class, e.g. `IfcWall`. */
  className: string;
  modelName: string;
  /** This element's record for the exported zone set. */
  assignment: ZoneAssignment;
  /** Declared volume bases (net/gross/unqualified), SI m³ — the same
   *  `declaredVolumeBases` result the properties panel renders. */
  declared: readonly DeclaredVolume[];
  /** The kernel's proved whole-mesh volume (m³) when the element is a proven
   *  solid — the mesh total for rows no clip ran for. `null` when no volume
   *  may be stated (the closure gate's answer, honoured here too). */
  provedMeshVolumeM3: number | null;
  /** SI m³ → the panel-resolved display unit (declared file unit, or the
   *  user's display override) — conversion only; rounding happens here. */
  toDisplayUnit: (m3: number) => number;
  /** Symbol of that display unit, e.g. `m³`. */
  unitSymbol: string;
}

/** The panel caps volumes at 4 fraction digits (`formatConverted`); the export
 *  rounds identically so the two can never disagree past display precision. */
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** The panel shows shares as a one-decimal percent; same here. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

const DECLARED_BASES: readonly Exclude<VolumeBasis, 'mesh'>[] = ['net', 'gross', 'unqualified'];

interface BasisCells {
  vol: number | null;
  total: number | null;
  qty: string | null;
}

/** The 12 basis-valued cells of one row, in column order. */
function basisCellTriples(cells: Record<VolumeBasis, BasisCells>): ZoneTableCell[] {
  return [
    cells.mesh.vol, cells.mesh.total,
    cells.net.vol, cells.net.total, cells.net.qty,
    cells.gross.vol, cells.gross.total, cells.gross.qty,
    cells.unqualified.vol, cells.unqualified.total, cells.unqualified.qty,
  ];
}

function emptyBasisCells(): Record<VolumeBasis, BasisCells> {
  return {
    mesh: { vol: null, total: null, qty: null },
    net: { vol: null, total: null, qty: null },
    gross: { vol: null, total: null, qty: null },
    unqualified: { vol: null, total: null, qty: null },
  };
}

export function buildZoneApportionmentTable(
  zoneSet: ZoneSet,
  entry: ZoneApportionmentEntry | null,
  elements: readonly ZoneTableElementSource[],
): ZoneApportionmentTable {
  const zoneNameById = new Map(zoneSet.zones.map((z) => [z.id, z.name]));
  const rows: ZoneTableCell[][] = [];

  for (const el of elements) {
    const identity: ZoneTableCell[] = [el.modelName, el.ifcGlobalId, el.name, el.className, zoneSet.name];

    const push = (
      zoneId: string | null,
      zoneName: string | null,
      status: ZoneTableStatus,
      sharePct: number | null,
      basisCells: Record<VolumeBasis, BasisCells>,
      note: string | null,
    ) => {
      rows.push([
        ...identity,
        zoneName ?? '',
        zoneId ?? '',
        el.assignment.straddles,
        status,
        sharePct,
        ...basisCellTriples(basisCells),
        el.unitSymbol,
        note,
      ]);
    };

    /** Totals-only cells for rows no split applies to: the whole element on
     *  every basis it carries. */
    const wholeCells = (withValues: boolean): Record<VolumeBasis, BasisCells> => {
      const cells = emptyBasisCells();
      if (el.provedMeshVolumeM3 !== null && Number.isFinite(el.provedMeshVolumeM3)) {
        const total = round4(el.toDisplayUnit(el.provedMeshVolumeM3));
        cells.mesh = { vol: withValues ? total : null, total, qty: null };
      }
      for (const d of el.declared) {
        const total = round4(el.toDisplayUnit(d.valueM3));
        cells[d.basis] = { vol: withValues ? total : null, total, qty: d.quantityName };
      }
      return cells;
    };

    const apportionment: ElementApportionment | undefined = entry?.byElement.get(el.globalId);
    if (apportionment) {
      const breakdowns = allBasisBreakdowns(apportionment, el.declared);
      const byBasis = new Map<VolumeBasis, BasisBreakdown>(breakdowns.map((b) => [b.basis, b]));
      const note = apportionment.overlapping
        ? 'zones overlap: shares double-count the overlap and do not sum to the whole'
        : null;

      const cellsAt = (pick: (b: BasisBreakdown) => number): Record<VolumeBasis, BasisCells> => {
        const cells = emptyBasisCells();
        for (const basis of ['mesh', ...DECLARED_BASES] as const) {
          const b = byBasis.get(basis);
          if (!b) continue;
          cells[basis] = {
            vol: round4(el.toDisplayUnit(pick(b))),
            total: round4(el.toDisplayUnit(b.totalM3)),
            qty: b.quantityName,
          };
        }
        return cells;
      };

      apportionment.shares.forEach((share, i) => {
        push(
          share.zoneId,
          share.zoneName,
          'apportioned',
          round1(share.fraction * 100),
          cellsAt((b) => b.shares[i].valueM3),
          note,
        );
      });
      // Same gate the panel's "in no zone" line uses.
      const meshOutside = byBasis.get('mesh')!.outsideM3;
      if (meshOutside > 0) {
        push(null, null, 'outside', round1(apportionment.outsideFraction * 100), cellsAt((b) => b.outsideM3), note);
      }
      continue;
    }

    if (el.assignment.straddles) {
      // A straddler with no split: refused with a reason, or simply never
      // computed for this entry. Either way it appears — once per touched
      // zone — with no number, never a guessed one.
      const status: ZoneTableStatus = entry?.refused.get(el.globalId) ?? 'not-computed';
      const touched = el.assignment.touchedZoneIds.length > 0
        ? el.assignment.touchedZoneIds
        : [el.assignment.zoneId].filter((id): id is string => id !== null);
      const cells = wholeCells(false);
      if (touched.length === 0) {
        push(null, null, status, null, cells, null);
      } else {
        for (const zoneId of touched) {
          push(zoneId, zoneNameById.get(zoneId) ?? '', status, null, cells, null);
        }
      }
      continue;
    }

    if (el.assignment.zoneId !== null) {
      // v1's whole-element assignment: everything it has sits in its home zone.
      push(el.assignment.zoneId, el.assignment.zoneName, 'whole', 100, wholeCells(true), null);
    } else {
      // In no zone of this set — a row, not an absence (#2508's "silently
      // unclassified" note applied to the export).
      push(null, null, 'no-zone', 100, wholeCells(true), null);
    }
  }

  return { columns: ZONE_TABLE_COLUMNS, rows };
}

/**
 * Wrap the table in the normalised model the existing list writers consume, so
 * CSV goes through the SAME `toCsv` as every Lists export — quoting, formula
 * injection guard (CWE-1236) and cell formatting included, none of it
 * reimplemented here. No grouping, no sums: the table IS the data.
 */
export function zoneTableExportModel(
  table: ZoneApportionmentTable,
  title: string,
  generatedAt: string,
): ExportModel {
  return {
    title,
    generatedAt,
    columns: table.columns.map((c) => ({ id: c.id, label: c.label, numeric: c.numeric, summed: false, width: 120 })),
    groups: null,
    rows: table.rows as CellValue[][],
    groupColumnId: null,
    groupColumnIds: [],
    sumColumnIds: [],
    totals: { count: table.rows.length, sums: {} },
    schedule: null,
  };
}

/**
 * The table as named columnar arrays for `columnsToParquet`
 * (`@ifc-lite/export`). Every volume/share column is declared Float64 so a
 * whole-number volume cannot demote the column to Int32 — the same rule the
 * BOS quantity tables apply.
 */
export function zoneTableParquetColumns(table: ZoneApportionmentTable): {
  columns: Record<string, ZoneTableCell[]>;
  floatColumns: Set<string>;
} {
  const columns: Record<string, ZoneTableCell[]> = {};
  const floatColumns = new Set<string>();
  table.columns.forEach((col, i) => {
    columns[col.label] = table.rows.map((r) => r[i]);
    if (col.numeric) floatColumns.add(col.label);
  });
  return { columns, floatColumns };
}
