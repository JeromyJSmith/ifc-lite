/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureIfcxEntityDistance } from './geometry-distance';
function source(gap: number) { return new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, imports: [], schemas: {}, data: ['a','b'].map((path, index) => ({ path, attributes: { 'bsi::ifc::class': { code: 'IfcWall' }, 'usd::usdgeom::mesh': { points: [[0,0,index*gap],[2,0,index*gap],[0,2,index*gap]], faceVertexIndices: [0,1,2] } } })) })).buffer; }
test('native triangle distance returns located witness points in the composed frame', () => {
  const result = measureIfcxEntityDistance(source(0.25), 'a', 'b');
  assert.equal(result.nearest.distance, 0.25);
  assert.equal(result.nearest.pointA[1], 0); assert.equal(result.nearest.pointB[1], 0.25);
  assert.equal(result.nearest.triangleA, 0); assert.equal(result.nearest.triangleB, 0);
  assert.match(result.limitation, /may be away from the reported junction/);
});
test('touch is reported as zero without claiming a repair or an absence of other gaps', () => {
  assert.equal(measureIfcxEntityDistance(source(0), 'a', 'b').nearest.distance, 0);
  assert.throws(() => measureIfcxEntityDistance(source(1), 'a', 'a'), /distinct/);
  assert.throws(() => measureIfcxEntityDistance(source(1), 'a', 'unknown'), /entity path/);
});

test('measurement carries composed entity identities rather than guessed selection roles', () => {
  const document = JSON.parse(new TextDecoder().decode(source(0)));
  document.data[0].attributes['bsi::ifc::class'] = { code: 'IfcRoof' };
  document.data[0].attributes['bsi::ifc::prop::Name'] = 'Old roof name';
  document.data[1].attributes['bsi::ifc::class'] = { code: 'IfcMember' };
  document.data[1].attributes['bsi::ifc::prop::Name'] = 'Rake board';
  document.data.push({ path: 'a', attributes: { 'bsi::ifc::prop::Name': 'Corrected roof slope' } });
  const result = measureIfcxEntityDistance(new TextEncoder().encode(JSON.stringify(document)).buffer, 'a', 'b');
  assert.equal(result.entityA.name, 'Corrected roof slope');
  assert.equal(result.entityA.ifcClass, 'IfcRoof');
  assert.equal(result.entityB.name, 'Rake board');
  assert.equal(result.entityB.ifcClass, 'IfcMember');
  assert.equal(result.nearest.distance, 0);
  const reversed = measureIfcxEntityDistance(new TextEncoder().encode(JSON.stringify(document)).buffer, 'b', 'a');
  assert.deepEqual(reversed.entityA, result.entityB);
  assert.deepEqual(reversed.entityB, result.entityA);
});
