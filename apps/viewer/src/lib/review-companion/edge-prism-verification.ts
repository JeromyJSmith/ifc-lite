/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { inspectIfcxGeometry, patchIfcxGeometry, analyzeIfcxMesh } from './ifcx-geometry';
import { readIfcxWorldGeometry, readIfcxEntityIdentities, extractIfcxEntityGeometry } from './ifcx-world-geometry';
import { verifyMeshSurfaceEquivalence } from './mesh-surface-equivalence';
import { sha256Hex } from '@/utils/sourceContentHash';
import type { UsdMesh } from '@ifc-lite/ifcx';
export interface EdgePrismComponent { pointOffset: number; referencePath: string; referencePointIndices: [number, number] }
export function edgePrismComponents(value: unknown): EdgePrismComponent[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Choose 1–32 source-backed edge prism components.');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['pointOffset','referencePath','referencePointIndices'].includes(key))) throw new Error('Invalid edge prism criteria.');
    const { pointOffset, referencePath, referencePointIndices: indices } = item;
    if (!Number.isSafeInteger(pointOffset) || pointOffset < 0 || typeof referencePath !== 'string' || !referencePath
      || !Array.isArray(indices) || indices.length !== 2 || indices.some(i => !Number.isSafeInteger(i) || i < 0) || indices[0] === indices[1]) throw new Error('Invalid edge prism criteria.');
    return { pointOffset, referencePath, referencePointIndices: [indices[0], indices[1]] };
  });
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sub = (a: number[], b: number[]) => a.map((v,i) => v-b[i]);
const add = (...points: number[][]) => [0,1,2].map(axis => points.reduce((sum,p) => sum+p[axis],0));
const distance = (a: number[], b: number[]) => Math.hypot(...sub(a,b));
const prism = (a: number[], b: number[], offset: number[], drop: number[]) => [a,b,add(b,offset),add(a,offset),add(a,drop),add(b,drop),add(b,offset,drop),add(a,offset,drop)];
function exactMesh(buffer: ArrayBuffer, path: string) {
  const meshes = inspectIfcxGeometry(buffer,path).meshes.filter(m => m.analysis.path === path);
  if (meshes.length !== 1) throw new Error('Alignment verification requires one exact entity body mesh.');
  return meshes[0].mesh;
}
/** Recompute an explicit edge-board postcondition, including the whole changed solids.
 * No imported verification, fitted dimensions, or count-only claims qualify a fix. */
export async function verifyEdgePrismAlignment(receipt: Record<string, unknown>, before: ArrayBuffer, applied: ArrayBuffer, current: ArrayBuffer, input: unknown) {
  if (receipt.operation !== 'replace_mesh' || typeof receipt.path !== 'string') throw new Error('Edge alignment requires a persisted mesh replacement.');
  const [beforeHash, appliedHash, currentHash] = await Promise.all([before,applied,current].map(sha256Hex));
  if (!beforeHash || !appliedHash || !currentHash || beforeHash !== receipt.beforeHash || appliedHash !== receipt.afterHash || beforeHash === appliedHash) throw new Error('Archived alignment sources do not match the actual application.');
  const path = receipt.path, components = edgePrismComponents(input);
  const original = exactMesh(before,path), repaired = exactMesh(applied,path), actual = exactMesh(current,path);
  if (!same(actual,repaired)) throw new Error('The current board mesh differs from the saved applied repair.');
  const { points: oldPoints, ...oldTopology } = original, { points: newPoints, ...newTopology } = repaired;
  if (oldPoints.length !== newPoints.length || !same(oldTopology,newTopology) || repaired.faceVertexCounts?.some(n => n !== 3)) throw new Error('Alignment changed the original topology or mesh attributes.');
  const replay = patchIfcxGeometry(before,{kind:'replace_mesh',meshPath:path,mesh:repaired});
  if (await sha256Hex(replay.correctedBuffer) !== appliedHash) throw new Error('The applied revision contains edits outside the recorded board mesh.');
  const boardIdentity = readIfcxEntityIdentities(current,[path])[0];
  if (!['IfcCovering','IfcMember','IfcBeam'].includes(boardIdentity.ifcClass)) throw new Error('This postcondition qualifies edge boards only.');
  const oldWorld = readIfcxWorldGeometry(before,path), appliedWorld = readIfcxWorldGeometry(applied,path), world = readIfcxWorldGeometry(current,path);
  if (world.instances.length !== 1 || world.points.length !== newPoints.length || oldWorld.points.length !== oldPoints.length || !same(world.points,appliedWorld.points)) throw new Error('Board instances or composed placement differ from the applied repair.');
  const changed = oldPoints.flatMap((point,i) => same(point,newPoints[i]) ? [] : [i]);
  if (!changed.length) throw new Error('No moved board vertices exist in this application.');
  const covered = new Set<number>(), checks = [];
  for (const component of components) {
    const start = component.pointOffset, end = start+8;
    if (end > oldPoints.length || component.referencePath === path || Array.from({length:8},(_,i)=>start+i).some(i=>covered.has(i))) throw new Error('Overlapping, self-referencing or out-of-range board component.');
    for (let i=start;i<end;i++) covered.add(i);
    if (!changed.some(i=>i>=start&&i<end)) throw new Error('Every qualified component must belong to the moved geometry.');
    const reference = readIfcxWorldGeometry(current,component.referencePath), savedReference = readIfcxWorldGeometry(applied,component.referencePath);
    const referenceIdentity = readIfcxEntityIdentities(current,[component.referencePath])[0];
    if (referenceIdentity.ifcClass !== 'IfcRoof' || !same(reference.points,savedReference.points) || reference.instances.length !== 1) throw new Error('The reference roof or its placement changed after application.');
    const [i,j] = component.referencePointIndices, a = reference.points[i], b = reference.points[j];
    if (!a || !b) throw new Error('Roof edge point index is out of range.');
    const mesh = extractIfcxEntityGeometry(current,component.referencePath)[0];
    let edge = false;
    for (let k=0;k<mesh.indices.length;k+=3) for (let n=0;n<3;n++) {
      const u=mesh.indices[k+n],v=mesh.indices[k+(n+1)%3]; if ((u===i&&v===j)||(u===j&&v===i)) edge=true;
    }
    if (!edge) throw new Error('The reference pair is not a native roof triangle edge.');
    const offset = sub(oldWorld.points[start+3],oldWorld.points[start]), drop = sub(oldWorld.points[start+4],oldWorld.points[start]);
    const magnitude = Math.max(...[...world.points.slice(start,end),a,b].flat().map(Math.abs),1);
    const tolerance = magnitude * 2**-23 * 4;
    if (tolerance >= Math.min(Math.hypot(...offset),Math.hypot(...drop))/100) throw new Error('Composed Float32 precision cannot qualify this board thickness/height.');
    const beforeExpected = prism(oldWorld.points[start],oldWorld.points[start+1],offset,drop);
    if (beforeExpected.some((p,n)=>distance(p,oldWorld.points[start+n])>tolerance)) throw new Error('Original component is not the declared eight-vertex edge-board construction.');
    const expected = prism(a,b,offset,drop), residual = Math.max(...expected.map((p,n)=>distance(p,world.points[start+n])));
    const priorEndpointError = Math.max(distance(oldWorld.points[start],a),distance(oldWorld.points[start+1],b));
    if (residual>tolerance || priorEndpointError<=tolerance) throw new Error('The application does not correct this roof-edge prism alignment.');
    const triangles: number[] = [];
    for (let k=0;k<repaired.faceVertexIndices.length;k+=3) {
      const face = repaired.faceVertexIndices.slice(k,k+3), inside = face.map(v=>v>=start&&v<end);
      if (inside.some(Boolean) && !inside.every(Boolean)) throw new Error('The selected board shares faces with unchecked geometry.');
      if (inside.every(Boolean)) triangles.push(...face.map(v=>v-start));
    }
    if (triangles.length!==36) throw new Error('An edge-board prism must retain twelve triangles.');
    const solidMesh: UsdMesh = {points:newPoints.slice(start,end),faceVertexIndices:triangles};
    const analysis = analyzeIfcxMesh(path,solidMesh);
    if (analysis.boundaryEdges.length || analysis.nonManifoldEdges.length || analysis.degenerateFaces.length || analysis.duplicateFaces.length) throw new Error('The repaired board is not a clean closed component.');
    const solid = await verifyMeshSurfaceEquivalence(solidMesh,solidMesh);
    if (solid.afterVolume<=0) throw new Error('The repaired board has no positive solid volume.');
    checks.push({...component,referenceIdentity,priorEndpointError,maxConstructionError:residual,tolerance,depth:Math.hypot(...offset),verticalHeight:Math.hypot(...drop),solid});
  }
  if (changed.some(i=>!covered.has(i))) throw new Error('Moved vertices outside the checked board components remain.');
  return {verified:true,kind:'edge-board-alignment' as const,path,boardIdentity,beforeHash,appliedHash,currentHash,components,checks,movedVertexCount:changed.length,
    scope:'Restored authored edge-board construction on unchanged roof edges. Independent as-built accuracy and other architectural details are not established.'};
}
