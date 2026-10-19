/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { inspectIfcxGeometry, MeshAnalysis } from './ifcx-geometry';
export type GeometryDigest = Omit<MeshAnalysis, 'degenerateFaces' | 'duplicateFaces' | 'boundaryEdges' | 'nonManifoldEdges'> & {
  degenerateCount: number; duplicateCount: number; defectiveFaceCount: number; boundaryEdgeCount: number; nonManifoldEdgeCount: number;
};
/** Full arrays remain in source evidence; send exact counts, bounds and transforms to the model. */
export function summarizeIfcxGeometry(report: ReturnType<typeof inspectIfcxGeometry>) {
  return { ...report, meshes: report.meshes.map(({ analysis, transform }) => {
    const { degenerateFaces, duplicateFaces, boundaryEdges, nonManifoldEdges, ...facts } = analysis;
    const digest: GeometryDigest = { ...facts, degenerateCount: degenerateFaces.length, duplicateCount: duplicateFaces.length,
      defectiveFaceCount: new Set([...degenerateFaces, ...duplicateFaces]).size, boundaryEdgeCount: boundaryEdges.length, nonManifoldEdgeCount: nonManifoldEdges.length };
    return { analysis: digest, transform };
  }) };
}
