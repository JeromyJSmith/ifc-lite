/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Columnar data → one Parquet file. Extracted from `ParquetExporter`'s private
 * conversion so a caller with a table that is NOT an `IfcDataStore` — the
 * per-element × per-zone volume table of issue #2508 is the motivating one —
 * writes Parquet through the same machinery as the BOS archive instead of a
 * second Arrow/parquet-wasm path that can drift. `ParquetExporter` delegates
 * here; this module deliberately stays a single function, not a framework.
 */

/**
 * Convert named columns (all the same length) to a Parquet file.
 *
 * Type mapping, per column, from the first non-null value: numbers become
 * Int32 when every value is a whole number and Float64 otherwise; columns
 * named in `floatColumns` are ALWAYS Float64, because content inference would
 * demote whole-number reals like `3.0`/`1200.0` to Int32 — losing the float
 * schema and risking wrap for |x| > 2^31. Booleans map to Bool, everything
 * else to strings. `null`/`undefined` entries survive as Parquet nulls.
 *
 * Falls back to the Arrow IPC stream bytes when parquet-wasm cannot convert —
 * still a valid, widely readable binary table — matching the BOS archive's
 * behaviour.
 */
export async function columnsToParquet(
    columns: Record<string, unknown[]>,
    floatColumns?: Set<string>,
): Promise<Uint8Array> {
    try {
        // Dynamic imports for better tree-shaking. The package's
        // browser/node exports map keeps `Arrow.dom.mjs` opaque to
        // TS5's strict resolver, so the import is typed `any` here
        // and consumers fall back to runtime checks. See:
        // https://github.com/apache/arrow/issues/35835
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const arrow: any = await import('apache-arrow');

        // Build Arrow vectors from column data
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vectors: Record<string, any> = {};

        for (const [name, data] of Object.entries(columns)) {
            if (data.length === 0) {
                // Empty column - create empty vector with null type
                vectors[name] = arrow.vectorFromArray([]);
                continue;
            }

            // Infer type from first non-null element
            const sample = data.find((v) => v !== null && v !== undefined);

            if (sample === undefined) {
                // All nulls - create string vector with nulls
                vectors[name] = arrow.vectorFromArray(data);
            } else if (typeof sample === 'number') {
                // Columns declared as REAL-typed by the caller (e.g. ValueReal,
                // quantity Value) always use Float64 — content inference alone
                // would demote whole-number reals like 3.0/1200.0 to Int32,
                // losing the float schema and risking wrap for |x| > 2^31.
                if (floatColumns?.has(name)) {
                    vectors[name] = arrow.vectorFromArray(data, new arrow.Float64());
                    continue;
                }
                // Otherwise check if it's integer or float by content.
                const isFloat = data.some((v) => typeof v === 'number' && !Number.isInteger(v));
                if (isFloat) {
                    vectors[name] = arrow.vectorFromArray(data, new arrow.Float64());
                } else {
                    // Use Int32 for integers (covers express IDs and most counts)
                    vectors[name] = arrow.vectorFromArray(data, new arrow.Int32());
                }
            } else if (typeof sample === 'boolean') {
                vectors[name] = arrow.vectorFromArray(data, new arrow.Bool());
            } else {
                // String or other - convert to string
                vectors[name] = arrow.vectorFromArray(data.map((v) => v === null || v === undefined ? null : String(v)));
            }
        }

        // Build Arrow Table
        const table = new arrow.Table(vectors);

        // Convert to Arrow IPC format
        const ipcBuffer = arrow.tableToIPC(table, 'stream');

        // Try to use parquet-wasm for conversion
        try {
            const parquet = await import('parquet-wasm');

            // parquet-wasm 0.5+ API: read Arrow IPC and write Parquet
            const arrowTable = parquet.Table.fromIPCStream(ipcBuffer);
            const parquetBuffer = parquet.writeParquet(arrowTable);

            return new Uint8Array(parquetBuffer);
        } catch (parquetError) {
            // Fallback: If parquet-wasm fails, return Arrow IPC format instead
            // This is still a valid binary format that can be read by many tools
            console.warn('[columnsToParquet] parquet-wasm conversion failed, returning Arrow IPC format:', parquetError);
            return new Uint8Array(ipcBuffer);
        }
    } catch (error) {
        // If all else fails, throw a descriptive error
        throw new Error(`Failed to convert to Parquet format: ${error}. Ensure apache-arrow and parquet-wasm are installed.`);
    }
}
