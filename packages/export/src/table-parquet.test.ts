/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { tableFromIPC } from 'apache-arrow';
import { readParquet } from 'parquet-wasm';
import { columnsToParquet } from './table-parquet.js';

/** Decode a Parquet buffer back to plain row objects for assertions. */
function decodeParquet(bytes: Uint8Array): { rows: Record<string, unknown>[]; typeOf: (name: string) => string } {
  const readTable = readParquet(bytes);
  const ipc = readTable.intoIPCStream();
  const table = tableFromIPC(ipc);
  return {
    rows: table.toArray().map((row) => row.toJSON()),
    typeOf: (name) => String(table.schema.fields.find((f) => f.name === name)?.type),
  };
}

describe('columnsToParquet', () => {
  it('round-trips a mixed-type table', async () => {
    const bytes = await columnsToParquet({
      GlobalId: ['wall-guid-1', 'wall-guid-1', 'col-guid'],
      Zone: ['Section 1', 'Section 2', 'Section 1'],
      Straddles: [true, true, false],
      Volume: [0.8, 1.2, 0.5],
    }, new Set(['Volume']));

    const { rows } = decodeParquet(bytes);
    expect(rows).toHaveLength(3);
    expect(rows[0].GlobalId).toBe('wall-guid-1');
    expect(rows[1].Zone).toBe('Section 2');
    expect(rows[2].Straddles).toBe(false);
    expect(rows[0].Volume).toBeCloseTo(0.8, 12);
  });

  it('keeps a declared float column Float64 even when every value is whole', async () => {
    // Content inference alone would demote [2, 4] to Int32 and lose the float
    // schema — the same rule ParquetExporter applies to quantity values.
    const bytes = await columnsToParquet({
      Volume: [2, 4],
      Count: [2, 4],
    }, new Set(['Volume']));

    const { typeOf } = decodeParquet(bytes);
    expect(typeOf('Volume')).toMatch(/Float/);
    expect(typeOf('Count')).toMatch(/Int/);
  });

  it('carries nulls through value columns', async () => {
    const bytes = await columnsToParquet({
      Status: ['apportioned', 'unproved-solid'],
      Volume: [0.8, null],
    }, new Set(['Volume']));

    const { rows } = decodeParquet(bytes);
    expect(rows[0].Volume).toBeCloseTo(0.8, 12);
    expect(rows[1].Volume).toBeNull();
  });
});
