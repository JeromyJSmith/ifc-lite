---
"@ifc-lite/viewer": minor
---

Let the Clash panel's Issues view group by any of the four `groupClashes` modes — spatial cluster, discipline rule, element-type pair, or affected element — instead of always clustering spatially. BCF export already offered all four (and the CLI exposes them as `--group`); the panel, the place users actually read results, was pinned to `cluster`.

That matters because spatial proximity cannot express every real grouping. Where a row of clashes along one wall sits further apart than the gap to the next wall, no radius separates them — "one issue per wall" is unreachable by clustering at any radius, while `element` grouping produces it directly.

The cluster radius now appears next to the selector only while cluster grouping is in use, since it drives nothing in the other modes. The BCF export dialog opens on whichever grouping the panel is showing, so an export can't silently disagree with the list on screen; its own selector still wins for that export. Spatial clustering remains the default and is unchanged.
