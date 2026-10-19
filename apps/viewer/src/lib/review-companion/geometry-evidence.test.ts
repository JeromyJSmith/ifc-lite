/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectIfcxGeometry } from './ifcx-geometry';
import { summarizeIfcxGeometry } from './geometry-evidence';
test('large actual topology becomes bounded evidence without losing counts, bounds or transforms', () => {
  const source = new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, imports: [], schemas: {}, data: [{ path: 'mesh', attributes: { 'usd::usdgeom::mesh': { points: [[0,0,0],[2,0,0],[0,3,0]], faceVertexIndices: Array.from({length: 10000}, () => [0,1,2]).flat() } } }] })).buffer;
  const report = inspectIfcxGeometry(source, 'mesh'), before = structuredClone(report), compact = summarizeIfcxGeometry(report);
  const facts = compact.meshes[0].analysis;
  assert.equal(facts.faceCount, 10000); assert.equal(facts.duplicateCount, 9999); assert.equal(facts.defectiveFaceCount, 9999);
  assert.equal(facts.degenerateCount, 0); assert.equal(facts.nonManifoldEdgeCount, 3);
  assert.deepEqual(facts.bounds, { min: [0,0,0], max: [2,3,0] });
  assert.equal('mesh' in compact.meshes[0], false); assert.equal('duplicateFaces' in facts, false);
  assert.ok(JSON.stringify(compact).length < 1200);
  assert.deepEqual(report, before);
});
