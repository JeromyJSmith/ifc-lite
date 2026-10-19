/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { readIfcxWorldGeometry, readIfcxEntityIdentities } from './ifcx-world-geometry';
export interface PointCorrespondence { pathA: string; pointIndexA: number; pathB: string; pointIndexB: number }
/** Explicit point pairs in the existing native composed frame, never inferred correspondences. */
export function measureIfcxPointCorrespondence(buffer: ArrayBuffer, input: unknown) {
  if (!Array.isArray(input) || !input.length || input.length > 32) throw new Error('Choose 1–32 explicit point pairs.');
  const pairs: PointCorrespondence[] = input.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid point correspondence.');
    const { pathA, pointIndexA, pathB, pointIndexB } = value;
    if (typeof pathA !== 'string' || !pathA || typeof pathB !== 'string' || !pathB
      || !Number.isSafeInteger(pointIndexA) || pointIndexA < 0 || !Number.isSafeInteger(pointIndexB) || pointIndexB < 0) throw new Error('Invalid point correspondence.');
    if (pathA === pathB && pointIndexA === pointIndexB) throw new Error('A point cannot independently check itself.');
    return { pathA, pointIndexA, pathB, pointIndexB };
  });
  const paths = [...new Set(pairs.flatMap(pair => [pair.pathA, pair.pathB]))];
  const identities = new Map(readIfcxEntityIdentities(buffer, paths).map(entity => [entity.path, entity]));
  const geometry = new Map(paths.map(path => [path, readIfcxWorldGeometry(buffer, path)]));
  const measured = pairs.map(pair => {
    const a = geometry.get(pair.pathA)!, b = geometry.get(pair.pathB)!;
    const pointA = a.points[pair.pointIndexA], pointB = b.points[pair.pointIndexB];
    if (!pointA || !pointB) throw new Error('Point index outside the native worldPoints array. Read the exact entity first.');
    return { ...pair, entityA: identities.get(pair.pathA)!, entityB: identities.get(pair.pathB)!, pointA, pointB,
      distance: Math.hypot(...pointA.map((value, axis) => value - pointB[axis])) };
  });
  return { pairs: measured, maxDistance: Math.max(...measured.map(pair => pair.distance)),
    coordinateSpace: 'Composed model space Y-up, Float32 precision; point indices address the concatenated worldPoints array returned by review_geometry_read, including instance offsets. External placement and georeferencing are not applied.',
    units: 'Source coordinate units; no dimensions or correspondence are inferred from an image.',
    limitation: 'Checks only the explicitly supplied point pairs. Coincident endpoints do not establish solid continuity, design intent, intermediate shape or independent as-built accuracy.' };
}
