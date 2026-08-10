---
"@ifc-lite/parser": patch
---

`getRawNamedAttributes` now names attributes across the bundled schema union (IFC2X3 + IFC4 + IFC4X3) instead of the IFC4 codegen pin alone. The pin answers an empty list for the ~251 classes it does not carry — the whole IFC4.3 infrastructure vocabulary (`IfcCourse`, `IfcPavement`, `IfcSignal`, `IfcRoad`, …) — so the query layer's `EntityNode.allAttributes`, and the viewer attributes panel it feeds, silently showed no attributes at all for such entities. Pinned IFC2X3/IFC4 classes answer exactly as before: the union is only consulted when the pinned list is empty, and the sole class where that changes the answer (`IfcObjectPlacement`, whose `PlacementRelTo` IFC4.3 hoisted up from `IfcLocalPlacement`) is abstract in every schema and can never appear as an entity's type.
