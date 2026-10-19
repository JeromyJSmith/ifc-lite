/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectIfcxContact } from './geometry-contact';

function source(a: number[][], b: number[][]) {
  return new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, imports: [], schemas: {},
    data: [a, b].map((points, i) => ({ path: i ? 'b' : 'a', attributes: { 'bsi::ifc::class': { code: 'IfcRoof' },
      'usd::usdgeom::mesh': { points, faceVertexIndices: points.map((_, i) => i) } } })) })).buffer;
}
const triangle = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];

test('native coplanar contact returns located surface area without claiming a defect', () => {
  const result = inspectIfcxContact(source(triangle, triangle), 'a', 'b', 0, 0);
  const surface = result.contacts.find(c => c.kind === 'surface')!;
  assert.ok(surface); assert.equal(surface.area, 2); assert.equal(surface.boundary.length, 3);
  assert.equal(result.nearest?.distance, 0); assert.equal(result.nearest?.triangleA, 0);
  assert.match(result.limitation, /not penetration volume/);
});

test('disjoint surfaces report measured clearance and no fabricated contact', () => {
  const result = inspectIfcxContact(source(triangle, triangle.map(([x, y, z]) => [x, y, z + 0.25])), 'a', 'b', -1, -1);
  assert.equal(result.contactCount, 0); assert.equal(result.nearest?.distance, 0.25);
});

test('a scoped triangle excludes contact elsewhere on the same entity', () => {
  const far = triangle.map(([x, y, z]) => [x + 10, y, z]);
  const buffer = source([...triangle, ...far], far);
  assert.ok(inspectIfcxContact(buffer, 'a', 'b', -1, -1).contactCount > 0);
  const scoped = inspectIfcxContact(buffer, 'a', 'b', 0, 0);
  assert.equal(scoped.contactCount, 0); assert.equal(scoped.nearest?.distance, 8);
  assert.equal(scoped.nearest?.triangleA, 0);
  assert.equal(inspectIfcxContact(buffer, 'a', 'b', 0, 1).nearest?.triangleA, 1);
});

test('crossing triangles report a line rather than silently treating zero distance as a shared face', () => {
  const result = inspectIfcxContact(source(triangle, [[0.5, 0, -1], [0.5, 0, 1], [0.5, 2, 0]]), 'a', 'b', 0, 0);
  assert.equal(result.nearest?.distance, 0);
  assert.ok(result.contacts.some(contact => contact.kind === 'line' && contact.length > 0));
});

test('invalid composed selections and self-contact are rejected', () => {
  const buffer = source(triangle, triangle);
  for (const [instance, face] of [[-1, 0], [1, 0], [0, 1], [0, 0.5]]) assert.throws(() => inspectIfcxContact(buffer, 'a', 'b', instance, face), /range|exact|instance/);
  assert.throws(() => inspectIfcxContact(buffer, 'a', 'a', 0, 0), /distinct/);
});
