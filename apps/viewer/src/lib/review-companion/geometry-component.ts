/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { inspectIfcxGeometry } from './ifcx-geometry';

/** Exact coordinate welding only: no tolerance can bridge a nearby separate surface. */
export function inspectGeometryComponent(buffer: ArrayBuffer, meshPath: string, seedFaceIndex: number) {
  const report = inspectIfcxGeometry(buffer, meshPath);
  const selected = report.meshes.find(m => m.analysis.path === meshPath);
  if (!selected) throw new Error('Choose an exact source mesh path, not an entity with descendant meshes.');
  const mesh = selected.mesh;
  const counts = mesh.faceVertexCounts?.length ? mesh.faceVertexCounts : Array(mesh.faceVertexIndices.length / 3).fill(3) as number[];
  if (!Number.isSafeInteger(seedFaceIndex) || seedFaceIndex < 0 || seedFaceIndex >= counts.length) throw new Error('Source face index is out of range. Rendered triangle indices are not source face indices for polygon meshes.');
  let offset = 0;
  const faces = counts.map(count => { const face = mesh.faceVertexIndices.slice(offset, offset + count); offset += count; return face; });
  const keys = mesh.points.map(point => point.join(','));
  const adjacent = new Map<string, number[]>();
  faces.forEach((face, index) => { for (const vertex of new Set(face.map(i => keys[i]))) { const list = adjacent.get(vertex) ?? []; list.push(index); adjacent.set(vertex, list); } });
  const queue = [seedFaceIndex], visited = new Set(queue), expanded = new Set<string>();
  for (let i = 0; i < queue.length; i++) for (const vertex of faces[queue[i]].map(v => keys[v])) {
    if (expanded.has(vertex)) continue;
    expanded.add(vertex);
    for (const face of adjacent.get(vertex)!) if (!visited.has(face)) { visited.add(face); queue.push(face); }
  }
  const faceIndices = queue.sort((a, b) => a - b);
  const vertices = [...new Set(faceIndices.flatMap(i => faces[i]))];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const i of vertices) for (let axis = 0; axis < 3; axis++) { bounds.min[axis] = Math.min(bounds.min[axis], mesh.points[i][axis]); bounds.max[axis] = Math.max(bounds.max[axis], mesh.points[i][axis]); }
  return { meshPath, seedFaceIndex, faceCount: faceIndices.length, totalFaceCount: faces.length, bounds,
    coordinateSpace: selected.analysis.coordinateSpace, connectivity: 'Faces sharing any exactly coincident vertex; point-touching pieces are one component.',
    faceIndices: faceIndices.slice(0, 256), truncated: faceIndices.length > 256,
    removalPlan: faceIndices.length < faces.length && faceIndices.length <= 256 ? { kind: 'remove_faces' as const, meshPath, faceIndices } : null,
    limitation: 'Connectivity does not establish a defect or authorize removal. A plan requires issue-specific intent and the exact source hash. No plan is emitted for the whole mesh or more than 256 faces.' };
}
