/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { REVIEW_RESOLUTION_SCHEMA } from './resolution-schema';
import { patchIfcxGeometry } from './ifcx-geometry';
import type { IfcxGeometryOperation } from './ifcx-geometry';

const ajv = new Ajv2020({ strict: false, strictNumbers: true, allErrors: true });
const validate = ajv.compile(REVIEW_RESOLUTION_SCHEMA);
const hash = 'a'.repeat(64), topicId = 'issue-one';
const source = { manifestRef: 'manifest-one', hash, byteLength: 100, chunkCount: 1 };
const counts = { faceCount: 1, degenerateCount: 0, duplicateCount: 0 };
function valid(value: unknown) { assert.equal(validate(value), true, JSON.stringify(validate.errors)); }
function invalid(value: unknown) { assert.equal(validate(value), false); }

test('schema accepts every implemented native IFCX geometry operation', () => {
  const operations: IfcxGeometryOperation[] = [
    { kind: 'remove_defective_faces', meshPath: 'wall/body' },
    { kind: 'remove_faces', meshPath: 'wall/body', faceIndices: [0, 2] },
    { kind: 'translate_mesh_local', meshPath: 'wall/body', delta: [0, 0, 0.01] },
    { kind: 'replace_mesh', meshPath: 'wall/body', mesh: { points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faceVertexIndices: [0, 1, 2] } },
    { kind: 'set_local_transform', path: 'wall', transform: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
  ];
  operations.forEach(valid);
  invalid({ kind: 'translate_mesh_local', meshPath: 'wall/body', delta: [0, 0] });
  invalid({ kind: 'translate_mesh_local', meshPath: 'wall/body', delta: [0, NaN, 1] });
  invalid({ kind: 'remove_faces', meshPath: 'wall/body', faceIndices: [-1] });
  invalid({ kind: 'remove_faces', meshPath: 'wall/body', faceIndices: [1, 1] });
  invalid({ kind: 'set_local_transform', path: 'wall', transform: [[1, 0], [0, 1]] });
  invalid({ kind: 'set_local_transform', path: 'wall', transform: [[1, 0, 0, 0.5], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] });
  invalid({ kind: 'pretend_fixed', meshPath: 'wall/body' });
});

test('schema captures persisted prepared/applied/verified source provenance and restart operations', () => {
  valid({ kind: 'review.geometry.source.chunk', index: 0, text: '{}', sha256: hash });
  valid({ kind: 'review.geometry.source', hash, byteLength: 100, chunks: [{ id: 'chunk-one', sha256: hash }] });
  valid({ kind: 'review.geometry.prepared', topicId, modelId: 'model', path: 'wall/body', operation: 'remove_defective_faces', diagnosis: 'Exact duplicate faces', beforeSource: source, afterSource: source, before: {}, after: {} });
  valid({ kind: 'review.geometry.applied', topicId, modelId: 'model', originalModelId: 'original', modelName: 'building.ifcx', path: 'wall/body', operation: 'remove_defective_faces', diagnosis: 'Exact duplicate faces', beforeHash: hash, afterHash: hash, beforeSource: source, afterSource: source, preparedRef: 'prepared', before: counts, after: counts });
  valid({ kind: 'review.geometry.verified', topicId, receiptRef: 'applied', afterHash: hash, matches: true, issueVerified: true, canonicalMeshCount: 1, expectedTriangles: 1, loadedTriangles: 1, actual: [{ path: 'wall/body', ...counts, bounds: { min: [0, 0, 0], max: [1, 1, 0] } }] });
  valid({ kind: 'review.geometry.resumed', topicId, receiptRef: 'applied', sourceHash: hash, modelId: 'reloaded' });
  valid({ kind: 'review.geometry.undone', topicId, receiptRef: 'applied', restoredHash: hash });
  invalid({ kind: 'review.geometry.source', hash: 'wrong hash', byteLength: 100, chunks: [] });
  invalid({ kind: 'review.geometry.verified', topicId, receiptRef: 'applied', afterHash: hash, matches: true, canonicalMeshCount: 1, expectedTriangles: 1, loadedTriangles: -1, actual: [] });
});

test('fixed workflow requires repair/verification evidence; native execution requires actual terminal result/error', () => {
  const workflow = { kind: 'review.bcf.workflow', topicId, stage: 'investigating', diagnosis: 'Inspecting source topology', evidenceRefs: ['inspection'], createdAt: '2026-10-19T12:00:00.000Z' };
  valid(workflow);
  valid({ ...workflow, stage: 'fixed', evidenceRefs: ['applied', 'verified'], mutationReceiptRef: 'applied', verificationRef: 'verified' });
  invalid({ ...workflow, stage: 'fixed' });
  invalid({ ...workflow, stage: 'fixed', mutationReceiptRef: 'applied', verificationRef: 'verified' });
  const native = { kind: 'review.native.call', id: 'native-one', phase: 'before', api: 'schema', namespace: 'store', method: 'addWall', args: [], mutating: true, timestamp: workflow.createdAt, topicId };
  valid(native);
  valid({ ...native, phase: 'after', result: { nativeResult: { ok: false, reason: 'Unsupported IFCX' }, readback: {} } });
  valid({ ...native, phase: 'error', error: 'Native refusal' });
  invalid({ ...native, phase: 'after' });
  invalid({ ...native, phase: 'error' });
  valid({ kind: 'review.workspace.call', id: 'command-one', phase: 'after', operation: 'command', target: 'tool:measure', timestamp: workflow.createdAt, result: { dispatched: true } });
});

test('structural schema is complementary to the native geometry validator', () => {
  const operation: IfcxGeometryOperation = { kind: 'remove_faces', meshPath: 'body', faceIndices: [9] };
  valid(operation); // Source-dependent index bounds are checked by the actual geometry handler.
  const buffer = new TextEncoder().encode(JSON.stringify({ header: {}, data: [{ path: 'body', attributes: { 'usd::usdgeom::mesh': { points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faceVertexIndices: [0, 1, 2] } } }] })).buffer;
  assert.throws(() => patchIfcxGeometry(buffer, operation), /Face index out of range/);
});
