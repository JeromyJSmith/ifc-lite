/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readIfcxWorldGeometry, summarizeWorldGeometry } from './ifcx-world-geometry';
const translation = (x: number, y: number, z: number) => ({ transform: [[1,0,0,0],[0,1,0,0],[0,0,1,0],[x,y,z,1]] });
const mesh = { points: [[0,0,0],[1,0,0],[0,1,0]], faceVertexIndices: [0,1,2] };
function fixture(rotated = false) { return new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, imports: [], schemas: {}, data: [
  { path: 'building', attributes: { 'usd::xformop': rotated ? { transform: [[0,1,0,0],[-1,0,0,0],[0,0,1,0],[10,20,30,1]] } : translation(10,20,30) }, children: { Wall: 'wall' } },
  { path: 'wall', attributes: { 'bsi::ifc::class': { code: 'IfcWall' }, 'usd::xformop': translation(1,2,3) }, children: { Body: 'body', Window: 'window' } },
  { path: 'body', attributes: { 'usd::usdgeom::mesh': mesh } },
  { path: 'window', attributes: { 'bsi::ifc::class': { code: 'IfcWindow' }, 'usd::xformop': translation(100,0,0), 'usd::usdgeom::mesh': mesh } },
] })).buffer; }
test('composed entity measurement applies ancestors, converts axes and excludes nested entities', () => {
  const report = readIfcxWorldGeometry(fixture(), 'wall');
  assert.deepEqual(report.points, [[11,33,-22],[12,33,-22],[11,33,-23]]);
  assert.deepEqual(report.bounds, { min: [11,33,-23], max: [12,33,-22] });
  assert.equal(report.instances.length, 1);
  const summary = summarizeWorldGeometry(report); assert.equal(summary.pointCount, 3); assert.equal('points' in summary, false);
  assert.match(summary.coordinateSpace, /Georeferencing.*not applied/);
  assert.throws(() => readIfcxWorldGeometry(fixture(), 'body'), /entity path/);
});

test('noncommuting parent rotation and child translation use the native point-child-parent order', () => {
  assert.deepEqual(readIfcxWorldGeometry(fixture(true), 'wall').points, [[8,33,-21],[8,33,-22],[7,33,-21]]);
});

test('distinct placements of a shared entity remain distinct instances', () => {
  const file = JSON.parse(new TextDecoder().decode(fixture()));
  file.data.push({ path: 'second-root', attributes: { 'usd::xformop': translation(20,40,60) }, children: { Wall: 'wall' } });
  const report = readIfcxWorldGeometry(new TextEncoder().encode(JSON.stringify(file)).buffer, 'wall');
  assert.equal(report.instances.length, 2);
  assert.ok(report.points.some(p => p[0] === 21 && p[1] === 63 && p[2] === -42));
  assert.ok(report.points.some(p => p[0] === 11 && p[1] === 33 && p[2] === -22));
});
