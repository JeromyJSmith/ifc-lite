/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { composeIfcx, extractEntities, extractGeometry } from '@ifc-lite/ifcx';
import { StringTable } from '@ifc-lite/data';
import { readIfcxGeometrySource } from './ifcx-geometry';
type Point = [number, number, number];
/** Use the viewer's canonical transform/instancing pipeline for one actual entity. */
export function readIfcxWorldGeometry(buffer: ArrayBuffer, entityPath: string) {
  const composed = composeIfcx(readIfcxGeometrySource(buffer));
  const { pathToId } = extractEntities(composed, new StringTable());
  const expressId = pathToId.get(entityPath);
  if (expressId === undefined) throw new Error('Composed placement requires an exact entity path, not a mesh path or label.');
  const meshes = extractGeometry(composed, pathToId, new Set([expressId]));
  if (!meshes.length) throw new Error('The entity has no visible composed mesh geometry.');
  const points: Point[] = [];
  const bounds = { min: [Infinity, Infinity, Infinity] as Point, max: [-Infinity, -Infinity, -Infinity] as Point };
  const instances = meshes.map((mesh, index) => {
    const offset = points.length;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const point: Point = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
      if (!point.every(Number.isFinite)) throw new Error('Non-finite composed geometry.');
      point.forEach((v, axis) => { bounds.min[axis] = Math.min(bounds.min[axis], v); bounds.max[axis] = Math.max(bounds.max[axis], v); });
      points.push(point);
    }
    return { index, pointOffset: offset, pointCount: points.length - offset, triangleCount: mesh.indices.length / 3 };
  });
  return { entityPath, points, bounds, instances,
    coordinateSpace: 'Composed model space, Y-up: [source X, source Z, -source Y]. Source ancestor/instance transforms applied by the native viewer extractor; Float32 precision. Georeferencing, external viewer placement and recentering are not applied.',
    limitation: 'Model geometry is not independent as-built evidence. Bounds do not measure a surface gap or establish architectural intent.' };
}
export function summarizeWorldGeometry(report: ReturnType<typeof readIfcxWorldGeometry>) {
  const { points, ...summary } = report;
  return { ...summary, pointCount: points.length };
}
