/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { ManifoldToplevel } from 'manifold-3d';
import type { UsdMesh } from '@ifc-lite/ifcx';
let kernel: Promise<ManifoldToplevel> | undefined;
async function solidKernel() {
  if (!kernel) kernel = (async () => {
    const { default: factory } = await import('manifold-3d');
    const node = typeof process !== 'undefined' && !!process.versions?.node;
    const wasm = node ? await factory() : await factory({ locateFile: () => wasmUrl! });
    wasm.setup(); return wasm;
  })();
  return kernel;
}
let wasmUrl: string | undefined;
/** Check the entire solids with the adopted kernel, not fitted points or sparse rays.
 * Source coordinates remain exact; the browser kernel comparison uses Float32,
 * like the native rendered geometry. All kernel objects are explicitly released. */
export async function verifyMeshSurfaceEquivalence(before: UsdMesh, after: UsdMesh) {
  if ([before, after].some(mesh => !mesh.points.length || mesh.points.some(p => p.length !== 3 || p.some(n => !Number.isFinite(n))))) throw new Error('Solid verification requires finite 3D coordinates.');
  const keys = new Set(before.points.map(p => JSON.stringify(p)));
  if (after.points.some(p => !keys.has(JSON.stringify(p)))) throw new Error('Topology repair introduced a new or moved vertex.');
  if ([before, after].some(mesh => mesh.faceVertexCounts?.some(n => n !== 3) || mesh.faceVertexIndices.length % 3)) throw new Error('Solid verification requires triangulated meshes.');
  if (typeof process === 'undefined' || !process.versions?.node) wasmUrl ??= (await import('manifold-3d/manifold.wasm?url')).default;
  const wasm = await solidKernel();
  const make = (mesh: UsdMesh) => new wasm.Manifold(new wasm.Mesh({ numProp: 3,
    vertProperties: new Float32Array(mesh.points.flat()), triVerts: new Uint32Array(mesh.faceVertexIndices) }));
  const objects: InstanceType<typeof wasm.Manifold>[] = [];
  try {
    const a = make(before); objects.push(a);
    const b = make(after); objects.push(b);
    if (a.status() !== 'NoError' || b.status() !== 'NoError') throw new Error('Before or replacement mesh is not a valid closed Manifold solid.');
    const lost = a.subtract(b); objects.push(lost);
    const added = b.subtract(a); objects.push(added);
    if (lost.status() !== 'NoError' || added.status() !== 'NoError') throw new Error('Solid difference verification failed.');
    const scale = Math.max(...[0, 1, 2].map(axis => {
      let lo = Infinity, hi = -Infinity;
      for (const point of before.points) { lo = Math.min(lo, point[axis]); hi = Math.max(hi, point[axis]); }
      return hi - lo;
    }));
    const volumeTolerance = Math.max(scale ** 3 * 1e-10, Math.abs(a.volume()) * 1e-9);
    const lostVolume = lost.volume(), addedVolume = added.volume();
    if (Math.abs(lostVolume) > volumeTolerance || Math.abs(addedVolume) > volumeTolerance
      || Math.abs(a.volume()-b.volume()) > volumeTolerance) throw new Error('Replacement changes the original solid beyond the declared numerical tolerance.');
    return { verified: true, kernel: 'manifold-3d 3.5.4', coordinatePrecision: 'Float32 comparison; exact original source vertices retained',
      beforeVolume: a.volume(), afterVolume: b.volume(), lostVolume, addedVolume, volumeTolerance, allOutputVerticesFromSource: true };
  } finally { for (const object of objects.reverse()) object.delete(); }
}
