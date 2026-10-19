/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom';
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeIfcx } from '@ifc-lite/ifcx';
import { parseIfcxViewerModel } from '@/hooks/ingest/viewerModelIngest';
import { analyzeIfcxMesh, inspectIfcxGeometry, patchIfcxGeometry, readIfcxGeometrySource } from './ifcx-geometry';
const mesh = { points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [2, 0, 0]], faceVertexIndices: [0, 1, 2, 1, 2, 0, 0, 1, 3] };
function source() {
  return new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, imports: [], schemas: {}, data: [
    { path: 'wall', attributes: { 'bsi::ifc::class': { code: 'IfcWall' }, 'bsi::ifc::prop::Name': 'Preserve me' }, children: { Body: 'wall-body' } },
    { path: 'wall-body', attributes: { 'usd::usdgeom::mesh': mesh } },
  ] })).buffer;
}
test('exact topology analysis distinguishes duplicate/degenerate faces and open boundaries', () => {
  const result = inspectIfcxGeometry(source(), 'wall');
  assert.equal(result.meshes.length, 1);
  assert.equal(result.meshes[0].analysis.path, 'wall-body');
  assert.deepEqual(result.meshes[0].analysis.duplicateFaces, [1]);
  assert.deepEqual(result.meshes[0].analysis.degenerateFaces, [2]);
  assert.match(result.limitation, /not proof/);
  assert.throws(() => inspectIfcxGeometry(source(), 'Preserve me'), /Exact IFCX path/);
});
test('repair preserves original opinions and passes adopted parser with corrected triangle count', async () => {
  const original = source(), originalText = new TextDecoder().decode(original);
  const result = patchIfcxGeometry(original, { kind: 'remove_defective_faces', meshPath: 'wall-body' });
  assert.equal(new TextDecoder().decode(original), originalText);
  assert.equal(result.before?.faceCount, 3); assert.equal(result.after?.faceCount, 1);
  const file = readIfcxGeometrySource(result.correctedBuffer);
  assert.deepEqual(file.data.slice(0, 2), readIfcxGeometrySource(original).data);
  assert.equal(file.data.length, 3);
  const before = await parseIfcxViewerModel(original), after = await parseIfcxViewerModel(result.correctedBuffer);
  assert.equal(before.geometryResult.totalTriangles, 3); assert.equal(after.geometryResult.totalTriangles, 1);
  assert.equal(after.dataStore.entities.getName(1), 'Preserve me');
  assert.throws(() => patchIfcxGeometry(result.correctedBuffer, { kind: 'remove_defective_faces', meshPath: 'wall-body' }), /No faces/);
});
test('opposite winding remains; exact coordinate duplicates work with split vertex indices', () => {
  const m = { points: [...mesh.points, ...mesh.points], faceVertexIndices: [0, 1, 2, 4, 5, 6, 0, 2, 1] };
  assert.deepEqual(analyzeIfcxMesh('a', m).duplicateFaces, [1]);
});
test('explicit measured translation stays in local Z-up and changes actual parsed geometry', async () => {
  const result = patchIfcxGeometry(source(), { kind: 'translate_mesh_local', meshPath: 'wall-body', delta: [0, 0, 2] });
  const parsed = await parseIfcxViewerModel(result.correctedBuffer);
  assert.equal(parsed.geometryResult.meshes[0].positions[1], 2);
  assert.deepEqual(result.after?.bounds.min, [0, 0, 2]);
});
test('explicit affine transform uses adopted row-major contract', async () => {
  const result = patchIfcxGeometry(source(), { kind: 'set_local_transform', path: 'wall', transform: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 4, 1]] });
  const parsed = await parseIfcxViewerModel(result.correctedBuffer);
  assert.equal(parsed.geometryResult.meshes[0].positions[1], 4);
  assert.equal(composeIfcx(readIfcxGeometrySource(result.correctedBuffer)).get('wall')?.attributes.get('bsi::ifc::prop::Name'), 'Preserve me');
});
test('invalid mesh, invalid transforms and destructive empty repairs refuse a patch', () => {
  assert.throws(() => analyzeIfcxMesh('bad', { points: [[0, 0, 0]], faceVertexIndices: [0, 0, 2] }), /out of range/);
  assert.throws(() => patchIfcxGeometry(source(), { kind: 'remove_faces', meshPath: 'wall-body', faceIndices: [0, 1, 2] }), /every face/);
  assert.throws(() => patchIfcxGeometry(source(), { kind: 'remove_faces', meshPath: 'wall-body', faceIndices: [8] }), /out of range/);
  assert.throws(() => patchIfcxGeometry(source(), { kind: 'set_local_transform', path: 'wall', transform: [[1]] }), /4x4/);
  assert.throws(() => patchIfcxGeometry(source(), { kind: 'translate_mesh_local', meshPath: 'wall-body', delta: [NaN, 0, 0] }), /finite/);
});
