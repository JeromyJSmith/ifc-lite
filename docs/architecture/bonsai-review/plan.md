# Implementation plan

Predecessor: inspect.md (pass). Owner: codex-bonsai-viewer. Baseline: 8cae63354.

1. Add lib/review-companion contracts, IndexedDB storage and roundtrip tests.
2. Add local Bonsai vision adapter, strict structured response handling and tests.
3. Reuse useBCF in a review panel, with typed notes, local dictation, monitoring,
   saved-view restoration, candidate status events and JSON export/import.
4. Wire a visible review launcher into ViewerLayout, using existing UI primitives.
5. Provision official Bonsai vision in shared persistent MARPA runtime paths.
6. Run targeted tests/typecheck, actual local inference and browser persistence
   checks. Record observed limitations without fabricating execution evidence.
7. Commit/push reviewed source and parent integration through main.

Expanded integration: add replay-validated process JSON, append-only snapshots,
AG-UI local activity events, exact screenshot-point native picking, and the native
IFC property preview/apply/readback/undo bridge. Qualify browser/Python CAD tools
separately; preserve the current geometry authority until an approved tracer and
independent checks justify a migration.
