/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMeshSurfaceEquivalence } from './mesh-surface-equivalence';
const tetra = {points:[[0,0,0],[1,0,0],[0,1,0],[0,0,1]], faceVertexIndices:[0,2,1,0,1,3,1,2,3,2,0,3]};
test('solid comparison accepts the same closed solid with reordered faces', async () => {
  const after = {...tetra, faceVertexIndices:[1,2,3,2,0,3,0,2,1,0,1,3]};
  const result = await verifyMeshSurfaceEquivalence(tetra,after);
  assert.equal(result.verified,true); assert.ok(Math.abs(result.beforeVolume-1/6)<1e-7);
});
test('new coordinates and an opened shell cannot pass solid verification', async () => {
  await assert.rejects(verifyMeshSurfaceEquivalence(tetra,{...tetra,points:[[0,0,0],[2,0,0],[0,1,0],[0,0,1]]}), /new or moved/);
  await assert.rejects(verifyMeshSurfaceEquivalence(tetra,{...tetra,faceVertexIndices:tetra.faceVertexIndices.slice(3)}), /valid closed|Not manifold/);
});
test('equal-volume solids using existing vertices cannot hide a changed shape', async () => {
  const before = {...tetra,points:[...tetra.points,[0,0,-1]]};
  const after = {...before,faceVertexIndices:[0,1,2,0,4,1,1,4,2,2,4,0]};
  await assert.rejects(verifyMeshSurfaceEquivalence(before,after), /changes the original solid/);
});
