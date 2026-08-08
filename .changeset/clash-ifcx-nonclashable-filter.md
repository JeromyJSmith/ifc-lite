---
"@ifc-lite/clash": patch
---

Fix `elementsFromIfcx` (the `@ifc-lite/clash/ifcx` adapter) treating any meshed IFCX entity as a clash candidate regardless of its IFC class. The STEP adapter already drops non-physical types (openings, virtual elements, grids, annotations, material associations) and spatial containers (storeys, spaces, sites, IFC4.3 road/bridge/facility) from the candidate set, because their geometry describes an extent that, by construction, encloses or overlaps the real elements assigned to it — not a coordination problem. The IFCX adapter had no equivalent filter: its geometry extractor associates a tessellated `Body` mesh with its nearest ancestor entity with no regard for that entity's IFC class, so an `IfcBuildingStorey` (or any other non-physical type) carrying its own extent in an IFCX export became exactly as real a clash candidate as it does in an unfixed STEP path.

Both adapters now share one predicate (`isNonClashableTag`, derived from a schema union walk over the bundled IFC2X3 + IFC4 + IFC4X3 entity tables, not a hand-maintained list) so the exclusion rules can't drift between representations. The IFCX adapter picks this up via `@ifc-lite/data` rather than `@ifc-lite/parser`, keeping the `@ifc-lite/clash/ifcx` subpath free of the STEP parser's much heavier dependency graph.
