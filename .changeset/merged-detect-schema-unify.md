---
"@ifc-lite/geometry": patch
---

The **merged** multi-model STEP exporter (`export_merged`/`export_merged_with_stats`) had its own, independent `detect_schema()` in `merged.rs`, with the same two defects already fixed in the single-model exporter's copy (`step_text.rs`): a raw, quote-blind search for `ENDSEC;`/`FILE_SCHEMA` that could match inside a header field's string value (e.g. a `FILE_DESCRIPTION` mentioning either token) and produce the wrong schema, and a fixed 4096-byte cutoff that could miss `FILE_SCHEMA` entirely on a header with a long earlier field.

Rather than porting the same quote-aware scan into a second copy, `merged.rs` now calls the single shared `step_text::detect_schema()` directly — the two duplicate implementations are unified into one, so this class of bug can no longer be fixed in one copy and left in the other.
