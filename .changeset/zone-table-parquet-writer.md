---
"@ifc-lite/export": minor
---

Add `columnsToParquet`, exposing `ParquetExporter`'s internal Arrow/parquet-wasm conversion as a standalone function: named columnar arrays in, one Parquet file out, with caller-declared Float64 columns and the same Arrow-IPC fallback as the BOS archive writers. `ParquetExporter` now delegates to it; its own behaviour is unchanged.
