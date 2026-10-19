/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ATTR, IFCX_APPEARANCE, composeIfcx, type IfcxFile, type UsdMesh } from '@ifc-lite/ifcx';

type Point = [number, number, number];
export type IfcxGeometryOperation =
  | { kind: 'remove_defective_faces'; meshPath: string }
  | { kind: 'remove_faces'; meshPath: string; faceIndices: number[] }
  | { kind: 'translate_mesh_local'; meshPath: string; delta: Point }
  | { kind: 'replace_mesh'; meshPath: string; mesh: UsdMesh }
  | { kind: 'set_local_transform'; path: string; transform: number[][] };
export interface MeshAnalysis {
  path: string;
  pointCount: number;
  faceCount: number;
  triangleCount: number;
  degenerateFaces: number[];
  duplicateFaces: number[];
  boundaryEdges: number[][];
  nonManifoldEdges: number[][];
  bounds: { min: Point; max: Point };
  coordinateSpace: 'IFCX mesh local Z-up; inherited transforms not applied';
}

/** Decode source bytes only; the adopted composer resolves layered/inherited opinions. */
export function readIfcxGeometrySource(buffer: ArrayBuffer): IfcxFile {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) throw new Error('Expected an IFCX document');
  const file = value as IfcxFile;
  for (const node of file.data) if (!node || typeof node.path !== 'string' || !node.path) throw new Error('IFCX node has no exact path');
  return file;
}
function checkedMesh(value: unknown): UsdMesh {
  if (!value || typeof value !== 'object') throw new Error('No mesh at exact IFCX path');
  const mesh = value as UsdMesh;
  if (!Array.isArray(mesh.points) || mesh.points.length === 0 || !Array.isArray(mesh.faceVertexIndices)) throw new Error('Invalid IFCX mesh arrays');
  for (const p of mesh.points) if (!Array.isArray(p) || p.length !== 3 || p.some(v => !Number.isFinite(v))) throw new Error('Mesh contains invalid point');
  for (const i of mesh.faceVertexIndices) if (!Number.isSafeInteger(i) || i < 0 || i >= mesh.points.length) throw new Error('Mesh index out of range');
  if (mesh.faceVertexCounts !== undefined && (!Array.isArray(mesh.faceVertexCounts) || mesh.faceVertexCounts.some(c => !Number.isSafeInteger(c) || c < 3) || mesh.faceVertexCounts.reduce((a, b) => a + b, 0) !== mesh.faceVertexIndices.length)) throw new Error('Invalid polygon counts');
  if (!mesh.faceVertexCounts?.length && mesh.faceVertexIndices.length % 3 !== 0) throw new Error('Triangle index count is not divisible by three');
  return mesh;
}
function faces(mesh: UsdMesh): number[][] {
  if (!mesh.faceVertexCounts?.length) return Array.from({ length: mesh.faceVertexIndices.length / 3 }, (_, i) => mesh.faceVertexIndices.slice(i * 3, i * 3 + 3));
  let offset = 0;
  return mesh.faceVertexCounts.map(count => { const face = mesh.faceVertexIndices.slice(offset, offset + count); offset += count; return face; });
}
function areaSquared(a: number[], b: number[], c: number[]): number {
  const u = b.map((v, i) => v - a[i]), v = c.map((n, i) => n - a[i]);
  return (u[1] * v[2] - u[2] * v[1]) ** 2 + (u[2] * v[0] - u[0] * v[2]) ** 2 + (u[0] * v[1] - u[1] * v[0]) ** 2;
}
export function analyzeIfcxMesh(path: string, value: unknown): MeshAnalysis {
  const mesh = checkedMesh(value), polygons = faces(mesh);
  const min: Point = [Infinity, Infinity, Infinity], max: Point = [-Infinity, -Infinity, -Infinity];
  const coordinateIds = new Map<string, number>();
  const welded = mesh.points.map(p => {
    p.forEach((n, i) => { min[i] = Math.min(min[i], n); max[i] = Math.max(max[i], n); });
    const key = p.join(',');
    if (!coordinateIds.has(key)) coordinateIds.set(key, coordinateIds.size);
    return coordinateIds.get(key)!;
  });
  const seen = new Set<string>(), edges = new Map<string, { edge: number[]; count: number }>();
  const degenerateFaces: number[] = [], duplicateFaces: number[] = [];
  let triangleCount = 0;
  polygons.forEach((face, index) => {
    triangleCount += face.length - 2;
    // Exact zero only: no inferred engineering tolerance or unit assumption.
    if (Array.from({ length: face.length - 2 }, (_, i) => areaSquared(mesh.points[face[0]], mesh.points[face[i + 1]], mesh.points[face[i + 2]])).every(a => a === 0)) degenerateFaces.push(index);
    const ids = face.map(i => welded[i]);
    // Preserve opposite winding; deliberately authored two-sided faces may use it.
    const key = ids.map((_, i) => [...ids.slice(i), ...ids.slice(0, i)].join(',')).sort()[0];
    if (seen.has(key)) duplicateFaces.push(index); else seen.add(key);
    for (let i = 0; i < face.length; i++) {
      const a = welded[face[i]], b = welded[face[(i + 1) % face.length]];
      if (a === b) continue;
      const edgeKey = [Math.min(a, b), Math.max(a, b)].join(',');
      const entry = edges.get(edgeKey) ?? { edge: [face[i], face[(i + 1) % face.length]], count: 0 };
      entry.count++; edges.set(edgeKey, entry);
    }
  });
  return { path, pointCount: mesh.points.length, faceCount: polygons.length, triangleCount, degenerateFaces, duplicateFaces,
    boundaryEdges: [...edges.values()].filter(e => e.count === 1).map(e => e.edge),
    nonManifoldEdges: [...edges.values()].filter(e => e.count > 2).map(e => e.edge), bounds: { min, max },
    coordinateSpace: 'IFCX mesh local Z-up; inherited transforms not applied' };
}

/** Include descendant body meshes, never substitute a display label for an exact path. */
export function inspectIfcxGeometry(buffer: ArrayBuffer, path: string) {
  const composed = composeIfcx(readIfcxGeometrySource(buffer));
  const root = composed.get(path);
  if (!root) throw new Error('Exact IFCX path is absent or deleted');
  const visited = new Set<string>();
  const meshes: Array<{ analysis: MeshAnalysis; mesh: UsdMesh; transform: unknown }> = [];
  function visit(node: typeof root) {
    if (!node || visited.has(node.path)) return;
    visited.add(node.path);
    const mesh = node.attributes.get(ATTR.MESH);
    if (mesh) meshes.push({ analysis: analyzeIfcxMesh(node.path, mesh), mesh: checkedMesh(mesh), transform: node.attributes.get(ATTR.TRANSFORM) ?? null });
    for (const child of node.children.values()) visit(child);
  }
  visit(root);
  return { path, transform: root.attributes.get(ATTR.TRANSFORM) ?? null, meshes,
    limitation: 'Boundary edges are topology evidence, not proof of an unintended architectural hole. Dimensions and transforms require measured intent.' };
}

/** Append strongest opinions; retain every original data node and all source metadata. Caller persists both buffers before canonical loadFile reload. */
export function patchIfcxGeometry(buffer: ArrayBuffer, operation: IfcxGeometryOperation) {
  if (!operation || typeof operation !== 'object' || !['remove_defective_faces', 'remove_faces', 'translate_mesh_local', 'replace_mesh', 'set_local_transform'].includes(operation.kind)) throw new Error('Unknown IFCX geometry operation');
  const file = readIfcxGeometrySource(buffer), composed = composeIfcx(file);
  const path = operation.kind === 'set_local_transform' ? operation.path : operation.meshPath;
  const node = composed.get(path);
  if (!node) throw new Error('Exact IFCX path is absent or deleted');
  let attribute: string, value: unknown;
  let before: MeshAnalysis | null = null, after: MeshAnalysis | null = null;
  if (operation.kind === 'set_local_transform') {
    const t = operation.transform;
    if (t.length !== 4 || t.some(row => row.length !== 4 || row.some(n => !Number.isFinite(n))) || t[0][3] !== 0 || t[1][3] !== 0 || t[2][3] !== 0 || t[3][3] !== 1) throw new Error('Expected finite affine row-major 4x4 IFCX transform');
    attribute = ATTR.TRANSFORM; value = { transform: t };
  } else {
    const original = checkedMesh(node.attributes.get(ATTR.MESH));
    before = analyzeIfcxMesh(path, original);
    let mesh: UsdMesh = structuredClone(original);
    if (operation.kind === 'replace_mesh') {
      mesh = checkedMesh(structuredClone(operation.mesh));
      if (node.attributes.has(IFCX_APPEARANCE) && mesh.points.length !== original.points.length) throw new Error('Textured replacement requires a matching UV mapping for every vertex');
    }
    else if (operation.kind === 'translate_mesh_local') {
      if (operation.delta.length !== 3 || operation.delta.some(n => !Number.isFinite(n))) throw new Error('Expected finite mesh-local XYZ displacement');
      mesh.points = mesh.points.map(p => p.map((n, i) => n + operation.delta[i]));
    } else {
      const remove = new Set(operation.kind === 'remove_defective_faces' ? [...before.degenerateFaces, ...before.duplicateFaces] : operation.faceIndices);
      if (remove.size === 0) throw new Error('No faces match the requested repair');
      for (const i of remove) if (!Number.isSafeInteger(i) || i < 0 || i >= before.faceCount) throw new Error('Face index out of range');
      const retained = faces(mesh).filter((_, i) => !remove.has(i));
      if (retained.length === 0) throw new Error('Repair would remove every face; use an explicit deletion workflow');
      mesh.faceVertexIndices = retained.flat();
      if (mesh.faceVertexCounts?.length) mesh.faceVertexCounts = retained.map(f => f.length);
      // Existing normals can be face-varying. The adopted parser recomputes them.
      delete mesh.normals;
      if (node.attributes.has(IFCX_APPEARANCE)) throw new Error('Textured mesh face removal requires preserving its face-varying UV mapping');
    }
    after = analyzeIfcxMesh(path, mesh); attribute = ATTR.MESH; value = mesh;
  }
  const previous = node.attributes.get(attribute);
  if (JSON.stringify(previous) === JSON.stringify(value)) throw new Error('Geometry operation is a no-op');
  file.data.push({ path, attributes: { [attribute]: value } });
  const correctedBuffer = new TextEncoder().encode(JSON.stringify(file)).buffer;
  return { correctedBuffer, path, operation: operation.kind, before, after,
    changedAttribute: attribute, limitation: 'Mesh-local repair; engineering intent and visual outcome must be verified before resolving a BCF issue.' };
}
