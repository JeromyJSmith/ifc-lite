/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureIfcxPointCorrespondence } from './geometry-correspondence';
function source() {
  const mesh = { points: [[0,0,0],[1,0,0],[0,1,0]], faceVertexIndices: [0,1,2] };
  return new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, data: [
    { path: 'a', attributes: { 'bsi::ifc::class': { code: 'IfcCovering' }, 'bsi::ifc::prop::Name': 'Board', 'usd::usdgeom::mesh': mesh } },
    { path: 'b', attributes: { 'bsi::ifc::class': { code: 'IfcRoof' }, 'bsi::ifc::prop::Name': 'Roof', 'usd::xformop': { transform: [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0.25,1]] }, 'usd::usdgeom::mesh': mesh } },
  ] })).buffer;
}
test('explicit endpoint pairs use composed coordinates and preserve pair identity, not whole-surface minima', () => {
  const input = source(), before = input.slice(0);
  const result = measureIfcxPointCorrespondence(input, [
    { pathA: 'a', pointIndexA: 0, pathB: 'b', pointIndexB: 0 },
    { pathA: 'a', pointIndexA: 1, pathB: 'b', pointIndexB: 0 },
  ]);
  assert.equal(result.pairs[0].distance, 0.25);
  assert.deepEqual(result.pairs[0].pointB, [0,0.25,-0]);
  assert.equal(result.pairs[1].distance, Math.hypot(1,0.25));
  assert.equal(result.maxDistance, result.pairs[1].distance);
  assert.equal(result.pairs[0].entityA.name, 'Board'); assert.equal(result.pairs[0].entityB.ifcClass, 'IfcRoof');
  assert.match(result.limitation, /only the explicitly supplied/);
  assert.deepEqual(input, before);
});
test('missing, out-of-range, fractional, self-paired and oversized correspondence requests fail', () => {
  const pair = { pathA: 'a', pointIndexA: 0, pathB: 'b', pointIndexB: 0 };
  for (const input of [[], Array(33).fill(pair), [{ ...pair, pointIndexA: -1 }], [{ ...pair, pointIndexB: 0.5 }], [{ ...pair, pointIndexB: 3 }], [{ ...pair, pathB: 'missing' }], [{ ...pair, pathB: 'a' }]]) assert.throws(() => measureIfcxPointCorrespondence(source(), input));
});
