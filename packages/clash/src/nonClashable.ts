/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared "is this IFC class ever a real clash candidate" predicate, used by
 * BOTH source adapters (`adapters/step.ts` and `adapters/ifcx.ts`) so the
 * exclusion rules live in exactly one place. A second hand-maintained copy
 * would drift the moment one adapter's list is updated and the other isn't —
 * which is exactly why the spatial-container half below is derived from the
 * schema instead of enumerated. (#1464, follow-up)
 *
 * Deliberately built on `@ifc-lite/data`'s raw `ENTITIES_*` tables rather
 * than `@ifc-lite/parser`'s `getInheritanceChainAcrossSchemas`: the ifcx
 * adapter is reached via the `@ifc-lite/clash/ifcx` subpath specifically so
 * consumers who only need IFCX (no STEP parsing, no wasm) don't pull in
 * `@ifc-lite/parser`'s much heavier dependency graph. `@ifc-lite/data` is
 * already a dependency of `@ifc-lite/ifcx` (and thus already on disk for any
 * ifcx consumer), and its union walk over the same three bundled schemas
 * produces byte-identical inheritance chains to the parser's version for
 * every class checked, including the IFC4.3 infrastructure leaves
 * (`IfcRoad`, `IfcBridge`, `IfcFacilityPart`) that motivated the schema-walk
 * approach in the first place.
 */

import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, type IfcEntityInfo } from '@ifc-lite/data';

/**
 * Types that are never physical clash candidates: voids, virtual/reference
 * geometry, and non-product material associations. Including them produced
 * phantom clashes (IfcVirtualElement, IfcOpeningElement, even
 * IfcMaterialConstituent) that no clash rule referenced - they are dropped from
 * the candidate set entirely, so "detect all" and per-rule runs only ever
 * consider real building elements. (#1464)
 *
 * Spatial containers are handled separately by {@link isSpatialContainerTag},
 * which derives them from the schema rather than from a list.
 */
const NON_CLASHABLE_TAGS: ReadonlySet<string> = new Set([
  'IfcOpeningElement',
  'IfcOpeningStandardCase',
  'IfcVirtualElement',
  'IfcGrid',
  'IfcGridAxis',
  'IfcAnnotation',
  'IfcMaterial',
  'IfcMaterialConstituent',
  'IfcMaterialLayer',
]);

// Union map across every bundled IFC schema (2X3 + 4 + 4X3), keyed
// uppercase. Same source tables `@ifc-lite/parser`'s schema union is built
// from, so IFC4.3 leaves the pinned codegen doesn't know (IfcRoad,
// IfcBridge, IfcFacilityPart, ...) still resolve their supertype chain.
const ENTITY_INFO_BY_UPPER: Map<string, IfcEntityInfo> = (() => {
  const map = new Map<string, IfcEntityInfo>();
  for (const list of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
    for (const entity of list) {
      map.set(entity.name.toUpperCase(), entity);
    }
  }
  return map;
})();

/** Memoizes the schema walk below; IFC type names are a bounded vocabulary. */
const spatialContainerByTag = new Map<string, boolean>();

/**
 * True for spatial *containers* - the entities whose geometry describes an
 * extent that, by construction, encloses the elements assigned to it. A storey
 * against the slab it contains is not a coordination problem, and IFC4.3
 * infrastructure exports routinely give IfcBuildingStorey / IfcRoad / IfcBridge
 * tessellated bodies, so every contained element clashed with its own
 * container. (follow-up to #1464)
 *
 * Derived from the schema, not enumerated: walks the bundled IFC2X3 + IFC4 +
 * IFC4X3 union, so the IFC4.3 facility leaves (IfcRoad, IfcBridge,
 * IfcFacilityPart, ...) resolve even though the STEP parser's own codegen pin
 * is IFC4_ADD2_TC1 and would return an empty chain for them via that path.
 * Both supertypes are checked because IFC2X3 has no `IfcSpatialElement` -
 * `IfcSpatialStructureElement` descends straight from `IfcProduct` there.
 */
function isSpatialContainerTag(tag: string): boolean {
  const cached = spatialContainerByTag.get(tag);
  if (cached !== undefined) return cached;

  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor = ENTITY_INFO_BY_UPPER.get(tag.toUpperCase());
  while (cursor && !seen.has(cursor.name)) {
    chain.push(cursor.name);
    seen.add(cursor.name);
    cursor = cursor.parent ? ENTITY_INFO_BY_UPPER.get(cursor.parent.toUpperCase()) : undefined;
  }

  const spatial = chain.some(
    (a) => a === 'IfcSpatialElement' || a === 'IfcSpatialStructureElement',
  );
  spatialContainerByTag.set(tag, spatial);
  return spatial;
}

/**
 * True when `tag` (an IFC class name, e.g. `element.tag` on a `ClashElement`)
 * must never become a clash candidate - openings, virtual/reference geometry,
 * material associations, grids/annotations, and spatial containers (storeys,
 * spaces, sites, IFC4.3 facility/road/bridge, ...). Shared by every source
 * adapter so the exclusion rules can't drift between representations.
 */
export function isNonClashableTag(tag: string): boolean {
  return NON_CLASHABLE_TAGS.has(tag) || isSpatialContainerTag(tag);
}
