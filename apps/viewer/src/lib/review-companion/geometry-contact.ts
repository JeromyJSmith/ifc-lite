/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { contactClusters, minDistanceBetweenMeshes } from '@ifc-lite/clash/contact';
import { extractIfcxEntityGeometry, readIfcxEntityIdentities } from './ifcx-world-geometry';

/** Native contact patches, optionally scoped to one composed triangle of entity A. */
export function inspectIfcxContact(buffer: ArrayBuffer, pathA: string, pathB: string, instanceA: number, triangleA: number) {
  if (pathA === pathB) throw new Error('Choose two distinct entities.');
  const a = extractIfcxEntityGeometry(buffer, pathA), b = extractIfcxEntityGeometry(buffer, pathB);
  if (!Number.isSafeInteger(instanceA) || instanceA < -1 || instanceA >= a.length) throw new Error('Composed instance A is out of range; -1 means all instances.');
  if (!Number.isSafeInteger(triangleA) || triangleA < -1 || (triangleA >= 0 && instanceA < 0)) throw new Error('Choose an exact composed instance before selecting its triangle.');
  if (triangleA >= 0 && triangleA >= a[instanceA].indices.length / 3) throw new Error('Composed triangle A is out of range. This is not a source polygon face index.');
  const contacts = [], distances = [];
  for (let i = 0; i < a.length; i++) {
    if (instanceA >= 0 && instanceA !== i) continue;
    const left = { id: pathA, positions: a[i].positions, indices: triangleA >= 0 ? a[i].indices.slice(triangleA * 3, triangleA * 3 + 3) : a[i].indices };
    for (let j = 0; j < b.length; j++) {
      const right = { id: pathB, positions: b[j].positions, indices: b[j].indices };
      const nearest = minDistanceBetweenMeshes(left, right);
      if (nearest) distances.push({ ...nearest, triangleA: triangleA >= 0 ? triangleA : nearest.triangleA, instanceA: i, instanceB: j });
      for (const cluster of contactClusters(left, right)) {
        contacts.push({ instanceA: i, instanceB: j, triangleA, kind: cluster.kind, centroid: cluster.centroid, normal: cluster.normal,
          area: cluster.area_m2, length: cluster.length_m, spanMin: cluster.spanMin, spanMax: cluster.spanMax,
          boundary: cluster.boundary.slice(0, 256), boundaryTruncated: cluster.boundary.length > 256, pairCount: cluster.pairs.length });
      }
    }
  }
  const [entityA, entityB] = readIfcxEntityIdentities(buffer, [pathA, pathB]);
  return { pathA, pathB, entityA, entityB, scope: { instanceA, triangleA }, contactCount: contacts.length, contacts: contacts.slice(0, 64), truncated: contacts.length > 64,
    nearest: distances.sort((a, b) => a.distance - b.distance)[0] ?? null,
    coordinateSpace: 'Composed model space Y-up, source transforms applied by native extraction at Float32 precision. External placement/recentering not applied.',
    units: 'Source coordinate units; area uses squared units and length uses source units. Metres require independently established model units.',
    limitation: 'Contact is touching or crossing surface evidence, not penetration volume, design intent or issue closure. A selected triangle can extend beyond the visual point. No contacts does not prove an architectural defect.' };
}
