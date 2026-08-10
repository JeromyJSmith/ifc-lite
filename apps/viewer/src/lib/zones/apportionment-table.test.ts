/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildZoneApportionmentTable,
  zoneTableExportModel,
  zoneTableParquetColumns,
  ZONE_TABLE_COLUMNS,
  type ZoneTableElementSource,
} from './apportionment-table.js';
import { toCsv } from '../lists/export/csv.js';
import type { ZoneApportionmentEntry } from './apportionment-cache.js';
import type { ElementApportionment } from './apportionment.js';
import type { ZoneAssignment, ZoneSet } from './types.js';

const ZONE_SET: ZoneSet = {
  id: 'set-1',
  name: 'Takt areas',
  visible: true,
  createdAt: 0,
  updatedAt: 0,
  zones: [
    { id: 'za', name: 'Section 1', center: [0, 0, 0], size: [10, 10, 10], rotationY: 0 },
    { id: 'zb', name: 'Section 2', center: [10, 0, 0], size: [10, 10, 10], rotationY: 0 },
  ],
};

/** Column index by id, so assertions read as prose. */
const COL: Record<string, number> = {};
ZONE_TABLE_COLUMNS.forEach((c, i) => { COL[c.id] = i; });

function share(zoneId: string, zoneName: string, volumeM3: number, fraction: number) {
  return { zoneId, zoneName, volumeM3, fraction };
}

function apportionment(partial: Partial<ElementApportionment> & Pick<ElementApportionment, 'wholeVolumeM3' | 'shares'>): ElementApportionment {
  return {
    outsideVolumeM3: 0,
    outsideFraction: 0,
    overlapping: false,
    unreliable: false,
    ...partial,
  };
}

function source(partial: Partial<ZoneTableElementSource> & Pick<ZoneTableElementSource, 'globalId' | 'assignment'>): ZoneTableElementSource {
  return {
    ifcGlobalId: `guid-${partial.globalId}`,
    name: `Element ${partial.globalId}`,
    className: 'IfcWall',
    modelName: 'model.ifc',
    declared: [],
    provedMeshVolumeM3: null,
    toDisplayUnit: (m3) => m3,
    unitSymbol: 'm³',
    ...partial,
  };
}

function assigned(zoneId: string | null, zoneName: string | null, straddles: boolean, touchedZoneIds: string[]): ZoneAssignment {
  return { zoneId, zoneName, straddles, touchedZoneIds };
}

function entryWith(
  byElement: Array<[number, ElementApportionment]>,
  refused: Array<[number, 'no-geometry' | 'unproved-solid' | 'rescaled-by-alignment']> = [],
): ZoneApportionmentEntry {
  return {
    revision: 'rev',
    byElement: new Map(byElement),
    refused: new Map(refused),
    computedAt: 0,
    elapsedMs: 1,
  };
}

/** The three-fixture set the export contract is pinned on: a straddler crossing
 *  two zones, a single-zone element, and an element in no zone of the set. */
function threeFixtureTable() {
  const straddler = source({
    globalId: 101,
    ifcGlobalId: 'wall-guid-1',
    name: 'Wall 1',
    className: 'IfcWall',
    assignment: assigned('za', 'Section 1', true, ['za', 'zb']),
    declared: [{ basis: 'net', quantityName: 'NetVolume', valueM3: 1.9 }],
  });
  const single = source({
    globalId: 102,
    ifcGlobalId: 'col-guid',
    name: 'Column',
    className: 'IfcColumn',
    assignment: assigned('za', 'Section 1', false, ['za']),
    provedMeshVolumeM3: 0.5,
    declared: [{ basis: 'gross', quantityName: 'GrossVolume', valueM3: 0.6 }],
  });
  const unzoned = source({
    globalId: 103,
    ifcGlobalId: 'beam-guid',
    name: 'Beam',
    className: 'IfcBeam',
    assignment: assigned(null, null, false, []),
    provedMeshVolumeM3: 0.3,
    declared: [{ basis: 'unqualified', quantityName: 'Volume', valueM3: 0.31 }],
  });
  const entry = entryWith([[101, apportionment({
    wholeVolumeM3: 2,
    shares: [share('za', 'Section 1', 0.8, 0.4), share('zb', 'Section 2', 1.2, 0.6)],
  })]]);
  return buildZoneApportionmentTable(ZONE_SET, entry, [straddler, single, unzoned]);
}

describe('zones/apportionment-table', () => {
  describe('the three-fixture contract', () => {
    it('a straddler appears once per zone it crosses — exactly twice for two zones', () => {
      const table = threeFixtureTable();
      const straddlerRows = table.rows.filter((r) => r[COL.globalId] === 'wall-guid-1');
      assert.strictEqual(straddlerRows.length, 2);
      assert.deepStrictEqual(straddlerRows.map((r) => r[COL.zone]), ['Section 1', 'Section 2']);
      assert.deepStrictEqual(straddlerRows.map((r) => r[COL.zoneId]), ['za', 'zb']);
      assert.strictEqual(straddlerRows[0][COL.status], 'apportioned');
      assert.strictEqual(straddlerRows[0][COL.straddles], true);
    });

    it('a straddler row carries the APPORTIONED value, not the element total', () => {
      const table = threeFixtureTable();
      const rows = table.rows.filter((r) => r[COL.globalId] === 'wall-guid-1');
      // Mesh basis: the clipped per-zone volumes, with the whole alongside.
      assert.strictEqual(rows[0][COL.volMesh], 0.8);
      assert.strictEqual(rows[1][COL.volMesh], 1.2);
      assert.strictEqual(rows[0][COL.totalMesh], 2);
      assert.strictEqual(rows[1][COL.totalMesh], 2);
      // Share column matches the panel's percent-with-one-decimal.
      assert.strictEqual(rows[0][COL.sharePct], 40);
      assert.strictEqual(rows[1][COL.sharePct], 60);
    });

    it('a declared basis is scaled by the mesh fraction and keeps its quantity name', () => {
      const table = threeFixtureTable();
      const rows = table.rows.filter((r) => r[COL.globalId] === 'wall-guid-1');
      // net = fraction × declared NetVolume (1.9): 0.76 / 1.14.
      assert.strictEqual(rows[0][COL.volNet], 0.76);
      assert.strictEqual(rows[1][COL.volNet], 1.14);
      assert.strictEqual(rows[0][COL.totalNet], 1.9);
      assert.strictEqual(rows[0][COL.qtyNet], 'NetVolume');
      // No gross/unqualified declared → those stay empty, never guessed.
      assert.strictEqual(rows[0][COL.volGross], null);
      assert.strictEqual(rows[0][COL.qtyGross], null);
      assert.strictEqual(rows[0][COL.volUnqualified], null);
    });

    it('a single-zone element appears once, whole, in its home zone', () => {
      const table = threeFixtureTable();
      const rows = table.rows.filter((r) => r[COL.globalId] === 'col-guid');
      assert.strictEqual(rows.length, 1);
      const r = rows[0];
      assert.strictEqual(r[COL.zone], 'Section 1');
      assert.strictEqual(r[COL.status], 'whole');
      assert.strictEqual(r[COL.straddles], false);
      assert.strictEqual(r[COL.sharePct], 100);
      // Mesh total comes from the kernel's proved volume — no clip ran.
      assert.strictEqual(r[COL.volMesh], 0.5);
      assert.strictEqual(r[COL.totalMesh], 0.5);
      assert.strictEqual(r[COL.volGross], 0.6);
      assert.strictEqual(r[COL.totalGross], 0.6);
      assert.strictEqual(r[COL.qtyGross], 'GrossVolume');
    });

    it('an element in no zone appears once with an EMPTY zone, not omitted', () => {
      // #2508: "a count of unclassified elements would stop a user trusting a
      // total that quietly omits them" — the export version of that rule. A
      // pivot over this CSV reconciles to the model because the no-zone bucket
      // is a row, not an absence.
      const table = threeFixtureTable();
      const rows = table.rows.filter((r) => r[COL.globalId] === 'beam-guid');
      assert.strictEqual(rows.length, 1);
      const r = rows[0];
      assert.strictEqual(r[COL.zone], '');
      assert.strictEqual(r[COL.zoneId], '');
      assert.strictEqual(r[COL.status], 'no-zone');
      assert.strictEqual(r[COL.volMesh], 0.3);
      assert.strictEqual(r[COL.volUnqualified], 0.31);
      assert.strictEqual(r[COL.qtyUnqualified], 'Volume');
    });

    it('the table is exactly the four rows the three fixtures owe', () => {
      assert.strictEqual(threeFixtureTable().rows.length, 4);
    });
  });

  describe('outside volume and refusals', () => {
    it('a straddler partly OUTSIDE every zone gets an outside row with an empty zone', () => {
      const el = source({
        globalId: 105,
        assignment: assigned('za', 'Section 1', true, ['za', 'zb']),
      });
      const entry = entryWith([[105, apportionment({
        wholeVolumeM3: 1,
        shares: [share('za', 'Section 1', 0.7, 0.7)],
        outsideVolumeM3: 0.3,
        outsideFraction: 0.3,
      })]]);
      const table = buildZoneApportionmentTable(ZONE_SET, entry, [el]);
      assert.strictEqual(table.rows.length, 2);
      const outside = table.rows[1];
      assert.strictEqual(outside[COL.zone], '');
      assert.strictEqual(outside[COL.status], 'outside');
      assert.strictEqual(outside[COL.volMesh], 0.3);
      assert.strictEqual(outside[COL.sharePct], 30);
    });

    it('a REFUSED straddler still appears — once per touched zone, reason as status, no number', () => {
      const el = source({
        globalId: 104,
        assignment: assigned('za', 'Section 1', true, ['za', 'zb']),
        declared: [{ basis: 'net', quantityName: 'NetVolume', valueM3: 1 }],
      });
      const table = buildZoneApportionmentTable(ZONE_SET, entryWith([], [[104, 'unproved-solid']]), [el]);
      assert.strictEqual(table.rows.length, 2);
      for (const r of table.rows) {
        assert.strictEqual(r[COL.status], 'unproved-solid');
        assert.strictEqual(r[COL.volMesh], null);
        assert.strictEqual(r[COL.volNet], null);
        assert.strictEqual(r[COL.sharePct], null);
      }
      // The declared total is a file fact and still travels.
      assert.strictEqual(table.rows[0][COL.totalNet], 1);
      assert.deepStrictEqual(table.rows.map((r) => r[COL.zone]), ['Section 1', 'Section 2']);
    });

    it('OVERLAPPING zones flag every apportioned row — a breakdown that double-counts must say so', () => {
      const el = source({ globalId: 108, assignment: assigned('za', 'Section 1', true, ['za', 'zb']) });
      const entry = entryWith([[108, apportionment({
        wholeVolumeM3: 1,
        shares: [share('za', 'Section 1', 0.8, 0.8), share('zb', 'Section 2', 0.7, 0.7)],
        overlapping: true,
      })]]);
      const table = buildZoneApportionmentTable(ZONE_SET, entry, [el]);
      for (const r of table.rows) {
        assert.match(String(r[COL.note]), /zones overlap/);
      }
    });

    it('a straddler the entry has never seen is not-computed, never silently a number', () => {
      const el = source({ globalId: 106, assignment: assigned('za', 'Section 1', true, ['za', 'zb']) });
      const table = buildZoneApportionmentTable(ZONE_SET, entryWith([]), [el]);
      assert.strictEqual(table.rows.length, 2);
      assert.strictEqual(table.rows[0][COL.status], 'not-computed');
      assert.strictEqual(table.rows[0][COL.volMesh], null);
    });
  });

  describe('units and precision', () => {
    it('values pass through the panel-resolved display conversion and round to its 4 digits', () => {
      const el = source({
        globalId: 107,
        assignment: assigned('za', 'Section 1', true, ['za', 'zb']),
        toDisplayUnit: (m3) => m3 * 1000, // e.g. a litres display override
        unitSymbol: 'L',
      });
      const entry = entryWith([[107, apportionment({
        wholeVolumeM3: 0.00123456789,
        shares: [share('za', 'Section 1', 0.000123456789, 0.1), share('zb', 'Section 2', 0.00111111111, 0.9)],
      })]]);
      const table = buildZoneApportionmentTable(ZONE_SET, entry, [el]);
      // 0.000123456789 m³ → 0.123456789 L → panel shows 4 fraction digits.
      assert.strictEqual(table.rows[0][COL.volMesh], 0.1235);
      assert.strictEqual(table.rows[0][COL.totalMesh], 1.2346);
      assert.strictEqual(table.rows[0][COL.unit], 'L');
      // Share matches the panel's one-decimal percent.
      assert.strictEqual(table.rows[0][COL.sharePct], 10);
    });
  });

  describe('CSV plumbing', () => {
    it('the basis labels survive into the CSV header — a bare number column would be the ambiguity #2515 refused', () => {
      const csv = toCsv(zoneTableExportModel(threeFixtureTable(), 'Takt areas', 'now'));
      const header = csv.split('\r\n')[0];
      for (const label of ['Volume (mesh)', 'Element total (mesh)', 'Volume (net)', 'Volume (gross)', 'Volume (unqualified)', 'Net quantity']) {
        assert.ok(header.includes(label), `header is missing "${label}": ${header}`);
      }
    });

    it('the straddler occupies two CSV data rows, its apportioned values on each', () => {
      const csv = toCsv(zoneTableExportModel(threeFixtureTable(), 'Takt areas', 'now'));
      const lines = csv.split('\r\n');
      assert.strictEqual(lines.length, 5); // header + 4 rows, no totals row
      const straddlerLines = lines.filter((l) => l.includes('wall-guid-1'));
      assert.strictEqual(straddlerLines.length, 2);
      assert.ok(straddlerLines[0].includes('0.8'));
      assert.ok(straddlerLines[1].includes('1.2'));
    });
  });

  describe('Parquet plumbing', () => {
    it('emits aligned columnar arrays with every volume column declared Float64', () => {
      const { columns, floatColumns } = zoneTableParquetColumns(threeFixtureTable());
      const labels = ZONE_TABLE_COLUMNS.map((c) => c.label);
      assert.deepStrictEqual(Object.keys(columns), labels);
      for (const label of labels) assert.strictEqual(columns[label].length, 4);
      for (const id of ['volMesh', 'totalMesh', 'volNet', 'totalNet', 'volGross', 'totalGross', 'volUnqualified', 'totalUnqualified', 'sharePct'] as const) {
        const label = ZONE_TABLE_COLUMNS.find((c) => c.id === id)!.label;
        assert.ok(floatColumns.has(label), `${label} must be a declared Float64 column`);
      }
      assert.strictEqual(columns['Volume (mesh)'][0], 0.8);
      assert.strictEqual(columns['GlobalId'][1], 'wall-guid-1');
      assert.strictEqual(columns['Straddles'][0], true);
    });
  });
});
