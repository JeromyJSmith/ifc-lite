# Visual review subprocess contract

The canonical exportable contract is [review-companion-process.schema.json](./review-companion-process.schema.json). The runtime in `apps/viewer/src/lib/review-companion/process.ts` uses the viewer's installed Ajv 8 to validate snapshots and replay their complete transition history. No dependency or database schema was added.

The process records inspection evidence, up to five grounded candidates, exact element binding, native previews, human approval, native application, readback and Undo. Zero findings is a valid result. The five-finding cap is a budget, never a target to fill. A screenshot cannot establish a measured dimension or authorize an invented replacement value.

## Execution and edit states

The process begins `not-started`, enters `running`, and ends `completed`, `interrupted` or `failed`. `completed` means the review loop ended; each finding independently records whether a correction was verified. A candidate can remain unresolved when a visual review completes.

Each finding follows:

```text
candidate → bound → previewed → approved → applied → verified
                                               ↘ undone
```

An applied or verified finding can become `undone` only with matching native before-value readback. Dismissal and blocked stages retain prior evidence. Failures and interruptions append events. Retry in a new run rather than clearing history.

An inspection references the persisted input context, screenshot, viewpoint and raw Bonsai response by ID. Binding requires a positive model-local express ID, an IFC GlobalId and the exact model source identity. A preview carries native digest, mutation version and explicit before/after values. The approval must pin the displayed preview and digest, identify the human review actor and reference the native review click. **Only the native human review UI callback emits approval. No model tool authorizes itself.** The JSON actor field records provenance; schema validation cannot authenticate a person or prove a click happened.

Application records the actual native receipt and native batch IDs. Verification compares readback against its recorded after values; Undo compares readback against its before values. An intention, success-shaped model response or image never substitutes for this readback. Existing native guards still own edit permission, stale previews, conflicting edits, atomic mutation and available Undo history. The subprocess does not replace them.

## Integration

`useReviewProcessJournal(persist)` exposes `begin`, `inspection`, `bind`, `append`, `finish`, `fail`, `interrupt`, `current` and `canonicalFindingId`. `finish` keeps the run open when a finding awaits approval or readback. Root callbacks append actual native preview/approval/apply/readback events; generic agent tools have no approval action.

Snapshots append to existing IndexedDB review notes. Their context omits duplicate image bytes and refers to the original captured input. Larger JSON is chunked below the note text limit and committed with a hash-linked manifest. `readReviewProcessSnapshot` refuses missing, changed or mismatched chunks and validates replay. `persistReviewJsonSnapshot` provides the same persistence boundary for other review artifacts. A failed write retains the current in-memory state for retry/export; it does not manufacture a durable success.

After a viewer reload, `recover(snapshot, rows)` restores a complete validated snapshot and its original input reference. A formerly running process receives an appended interruption event and never resumes automatically. Terminal snapshots restore without adding duplicate history. Recovery cannot replace a newly established process.

Optional `operation` linkage carries MARPA operation/run/project/parent identifiers and an explicit qualification state; optional artifacts carry URI, SHA-256 and role. These fields support the owner-supplied *Repeatable MARPA IFCX Operations Method* reference (Universal process contract, read 2026-10-19), without adopting that proposal as standing governance or introducing another general execution engine. The schema does not resolve registered artifacts, verify their bytes or automatically raise qualification.

Existing native contracts consulted: `model-change-preview.ts`, `model-change-commit.ts`, `model-change-values.ts`, `receipts.ts`, `validation-rerun.ts`, `edited-model-bytes.ts`, and `packages/ai/src/model-change.ts`. Scalar IFC metadata correction is distinct from geometry authoring. The canonical IFC-Lite Rust geometry path remains authoritative; this review contract adds no alternate CAD kernel.
