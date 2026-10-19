/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectGeometryComponent } from './geometry-component';
function source() { return new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, data: [{ path: 'body', attributes: { 'usd::usdgeom::mesh': {
  points: [[0,0,0],[1,0,0],[0,1,0],[0,0,0],[-1,0,0],[0,-1,0],[10,0,0],[11,0,0],[10,1,0]], faceVertexIndices: [0,1,2,3,4,5,6,7,8],
} } }] })).buffer; }
test('component planning welds exact duplicated coordinates without bridging separate pieces', () => {
  const input = source(), before = input.slice(0);
  const a = inspectGeometryComponent(input, 'body', 0);
  assert.deepEqual(a.removalPlan?.faceIndices, [0,1]);
  assert.deepEqual(inspectGeometryComponent(input, 'body', 2).removalPlan?.faceIndices, [2]);
  assert.deepEqual(input, before);
  assert.match(a.connectivity, /point-touching/);
});
test('invalid source face and non-mesh path refuse analysis', () => {
  for (const i of [-1,3,NaN,0.5]) assert.throws(() => inspectGeometryComponent(source(), 'body', i), /out of range/);
  assert.throws(() => inspectGeometryComponent(source(), 'missing', 0), /absent/);
});
test('whole-mesh components never produce an emptying removal plan', () => {
  const file = JSON.parse(new TextDecoder().decode(source()));
  file.data[0].attributes['usd::usdgeom::mesh'].faceVertexIndices = [0,1,2,3,4,5];
  const result = inspectGeometryComponent(new TextEncoder().encode(JSON.stringify(file)).buffer, 'body', 0);
  assert.equal(result.faceCount, result.totalFaceCount);
  assert.equal(result.removalPlan, null);
});
