/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { readGeometrySource } from './geometry-sources';
import { inspectIfcxGeometry, patchIfcxGeometry } from './ifcx-geometry';
import { sha256Hex } from '@/utils/sourceContentHash';
import type { ReviewFinding } from './types';
/** Recompute a cleanup from preserved source bytes; imported claims never replace native geometry checks. */
export async function verifyGeometryCleanup(receipt: Record<string, unknown>, verification: Record<string, unknown>, rows: ReviewFinding[], currentBuffer: ArrayBuffer) {
  if (receipt.operation !== 'remove_defective_faces') throw new Error('This geometry operation has no qualified issue-specific postcondition. Keep the issue open pending independent verification.');
  if (verification.matches !== true || typeof receipt.afterHash !== 'string' || verification.afterHash !== receipt.afterHash
    || typeof receipt.path !== 'string' || !receipt.path) throw new Error('Geometry verification does not match the applied cleanup source.');
  const source = receipt.beforeSource as { manifestRef?: unknown } | null;
  if (!source || typeof source.manifestRef !== 'string') throw new Error('The original cleanup source archive is missing.');
  const beforeBuffer = await readGeometrySource(source.manifestRef, rows);
  const beforeHash = await sha256Hex(beforeBuffer);
  if (!beforeHash || beforeHash !== receipt.beforeHash) throw new Error('The preserved original source does not match the cleanup receipt.');
  const expected = patchIfcxGeometry(beforeBuffer, { kind: 'remove_defective_faces', meshPath: receipt.path });
  const expectedHash = await sha256Hex(expected.correctedBuffer), actualHash = await sha256Hex(currentBuffer);
  if (!expectedHash || expectedHash !== receipt.afterHash || actualHash !== expectedHash) throw new Error('The current source is not the independently recomputed exact cleanup revision.');
  const before = inspectIfcxGeometry(beforeBuffer, receipt.path), after = inspectIfcxGeometry(currentBuffer, receipt.path);
  if (!before.meshes.length || !after.meshes.length || after.meshes.some(mesh => mesh.analysis.faceCount < 1 || mesh.analysis.degenerateFaces.length || mesh.analysis.duplicateFaces.length)) throw new Error('The actual corrected mesh still has defective faces or no retained geometry.');
  const beforeFaceCount = before.meshes.reduce((count, mesh) => count + mesh.analysis.faceCount, 0);
  const afterFaceCount = after.meshes.reduce((count, mesh) => count + mesh.analysis.faceCount, 0);
  const removedFaceCount = beforeFaceCount - afterFaceCount;
  const measuredDefects = before.meshes.reduce((count, mesh) => count + new Set([...mesh.analysis.degenerateFaces, ...mesh.analysis.duplicateFaces]).size, 0);
  if (removedFaceCount < 1 || removedFaceCount !== measuredDefects) throw new Error('Actual removed faces do not match the independently measured defect set.');
  for (const [key, measured] of [['before', beforeFaceCount], ['after', afterFaceCount]] as const) {
    const claim = receipt[key];
    if (claim !== undefined && claim !== null && (typeof claim !== 'object' || !('faceCount' in claim) || claim.faceCount !== measured)) throw new Error(`Receipt ${key} face count differs from actual source geometry.`);
  }
  return { verified: true, operation: 'remove_defective_faces' as const, path: receipt.path, beforeHash, afterHash: actualHash,
    beforeFaceCount, afterFaceCount, removedFaceCount, degenerateFaceCount: 0, duplicateFaceCount: 0, meshCount: after.meshes.length };
}
