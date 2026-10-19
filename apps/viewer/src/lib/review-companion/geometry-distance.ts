/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { minDistanceBetweenMeshes, type MeshDistance } from '@ifc-lite/clash/contact';
import { extractIfcxEntityGeometry, readIfcxEntityIdentities } from './ifcx-world-geometry';
/** One same-source pair, measured by the installed native triangle-distance solver. */
export function measureIfcxEntityDistance(buffer: ArrayBuffer, pathA: string, pathB: string) {
  if (pathA === pathB) throw new Error('Choose two distinct entities; self-distance cannot diagnose a junction.');
  const a = extractIfcxEntityGeometry(buffer, pathA), b = extractIfcxEntityGeometry(buffer, pathB);
  let nearest: (MeshDistance & { instanceA: number; instanceB: number }) | null = null;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const found = minDistanceBetweenMeshes({ id: pathA, positions: a[i].positions, indices: a[i].indices }, { id: pathB, positions: b[j].positions, indices: b[j].indices });
    if (found && (!nearest || found.distance < nearest.distance)) nearest = { ...found, instanceA: i, instanceB: j };
  }
  if (!nearest) throw new Error('No measurable triangle surfaces for this entity pair.');
  if (!Number.isFinite(nearest.distance)) throw new Error('Native distance is not finite.');
  const [entityA, entityB] = readIfcxEntityIdentities(buffer, [pathA, pathB]);
  return { pathA, pathB, entityA, entityB, nearest, instancesA: a.length, instancesB: b.length,
    coordinateSpace: 'Composed model space Y-up; source transforms applied by native viewer extraction, Float32 precision. Georeferencing and external viewer placement/recentering not applied.',
    units: 'Source coordinate units; this measurement does not infer metres from an image or missing unit declarations.',
    limitation: 'Global minimum over both complete entities. Witness points locate the measured contact, which may be away from the reported junction. Zero means surfaces touch or intersect somewhere; it is not penetration depth, architectural acceptance or an as-built dimension.' };
}
