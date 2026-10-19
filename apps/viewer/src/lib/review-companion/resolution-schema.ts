/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { ISSUE_STAGES } from './issue-workflow';
import type { IfcxGeometryOperation } from './ifcx-geometry';

const ref = { type: 'string', minLength: 1, maxLength: 512 };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const timestamp = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' };
const nonnegative = { type: 'integer', minimum: 0 };
const point = { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } };
const affineRow = (w: number) => ({ type: 'array', minItems: 4, maxItems: 4,
  prefixItems: [{ type: 'number' }, { type: 'number' }, { type: 'number' }, { const: w }], items: false });
const referenceList = { type: 'array', maxItems: 100, uniqueItems: true, items: ref };
const sourceReference = { type: 'object', required: ['manifestRef', 'hash', 'byteLength', 'chunkCount'], additionalProperties: false,
  properties: { manifestRef: ref, hash, byteLength: { type: 'integer', minimum: 1 }, chunkCount: { type: 'integer', minimum: 1, maximum: 10000 } } };
const countSummary = { anyOf: [{ type: 'null' }, { type: 'object', required: ['faceCount', 'degenerateCount', 'duplicateCount'], additionalProperties: false,
  properties: { faceCount: nonnegative, degenerateCount: nonnegative, duplicateCount: nonnegative } }] };
const mesh = { type: 'object', required: ['points', 'faceVertexIndices'], properties: {
  points: { type: 'array', minItems: 1, items: point }, faceVertexIndices: { type: 'array', items: nonnegative },
  faceVertexCounts: { type: 'array', items: { type: 'integer', minimum: 3 } },
  normals: { type: 'array', items: point },
}, additionalProperties: true };
const operations = [
  { kind: { const: 'remove_defective_faces' }, meshPath: ref },
  { kind: { const: 'remove_faces' }, meshPath: ref, faceIndices: { type: 'array', minItems: 1, uniqueItems: true, items: nonnegative } },
  { kind: { const: 'translate_mesh_local' }, meshPath: ref, delta: point },
  { kind: { const: 'replace_mesh' }, meshPath: ref, mesh },
  { kind: { const: 'set_local_transform' }, path: ref, transform: { type: 'array', minItems: 4, maxItems: 4,
    prefixItems: [affineRow(0), affineRow(0), affineRow(0), affineRow(1)], items: false } },
] satisfies Array<{ kind: { const: IfcxGeometryOperation['kind'] }; [key: string]: unknown }>;
const operationKinds = operations.map(operation => operation.kind.const);
const operation = { oneOf: operations.map(properties => ({ type: 'object', required: Object.keys(properties), additionalProperties: false, properties })) };
const record = (kind: string, properties: Record<string, unknown>, required: string[]) => ({ type: 'object', required: ['kind', ...required],
  properties: { kind: { const: kind }, ...properties }, additionalProperties: true });

/** Portable shape contract. Native readers additionally check live source, mesh indices, hashes and receipt associations. */
export const REVIEW_RESOLUTION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:ifc-lite:review-resolution:1', title: 'IFC-Lite saved issue investigation and repair',
  description: 'Schema for actual persisted resolution journal payloads and typed IFCX operations. Coordinates are mesh-local IFC Z-up in the source document units; missing units remain unknown. Schema validation does not establish engineering intent, persistence, geometry correctness or a verified repair.',
  $defs: {
    geometryOperation: operation,
    sourceReference,
    workflow: {
      ...record('review.bcf.workflow', { topicId: ref, stage: { enum: [...ISSUE_STAGES] }, diagnosis: { type: 'string', minLength: 1, maxLength: 8000 },
        evidenceRefs: referenceList, mutationReceiptRef: ref, verificationRef: ref, createdAt: timestamp }, ['topicId', 'stage', 'diagnosis', 'evidenceRefs', 'createdAt']),
      allOf: [{ if: { properties: { stage: { const: 'fixed' } }, required: ['stage'] }, then: {
        required: ['mutationReceiptRef', 'verificationRef'], properties: { evidenceRefs: { ...referenceList, minItems: 2 } },
        description: 'Runtime also requires distinct mutation and verification references, both in evidenceRefs, persisted for this exact topic, with verified current corrected source. Only diagnosed mesh-integrity cleanup currently qualifies for automatic closure.',
      } }],
    },
    sourceChunk: record('review.geometry.source.chunk', { index: nonnegative, text: { type: 'string', minLength: 1, maxLength: 30000 }, sha256: hash }, ['index', 'text', 'sha256']),
    sourceManifest: record('review.geometry.source', { hash, byteLength: { type: 'integer', minimum: 1 }, chunks: { type: 'array', minItems: 1, maxItems: 10000,
      items: { type: 'object', required: ['id', 'sha256'], additionalProperties: false, properties: { id: ref, sha256: hash } } } }, ['hash', 'byteLength', 'chunks']),
    nativeCall: {
      ...record('review.native.call', { id: ref, phase: { enum: ['before', 'after', 'error'] }, api: { enum: ['schema', 'backend'] }, namespace: ref,
        method: ref, args: { type: 'array' }, mutating: { type: 'boolean' }, timestamp, topicId: { anyOf: [ref, { type: 'null' }] }, result: {}, error: { type: 'string', minLength: 1 } },
      ['id', 'phase', 'api', 'namespace', 'method', 'args', 'mutating', 'timestamp']),
      allOf: [
        { if: { properties: { phase: { const: 'after' } }, required: ['phase'] }, then: { required: ['result'] } },
        { if: { properties: { phase: { const: 'error' } }, required: ['phase'] }, then: { required: ['error'] } },
      ],
    },
    workspaceCall: {
      ...record('review.workspace.call', { id: ref, phase: { enum: ['before', 'after', 'error'] }, operation: { enum: ['command', 'evidence'] }, target: ref,
        timestamp, topicId: { anyOf: [ref, { type: 'null' }] }, result: {}, error: { type: 'string', minLength: 1 } }, ['id', 'phase', 'operation', 'target', 'timestamp']),
      allOf: [
        { if: { properties: { phase: { const: 'after' } }, required: ['phase'] }, then: { required: ['result'] } },
        { if: { properties: { phase: { const: 'error' } }, required: ['phase'] }, then: { required: ['error'] } },
      ],
    },
    geometryPrepared: record('review.geometry.prepared', { topicId: ref, modelId: ref, path: ref, operation: { enum: operationKinds }, diagnosis: { type: 'string', minLength: 1 },
      beforeSource: sourceReference, afterSource: sourceReference, before: { type: ['object', 'null'] }, after: { type: ['object', 'null'] } },
    ['topicId', 'modelId', 'path', 'operation', 'diagnosis', 'beforeSource', 'afterSource', 'before', 'after']),
    geometryApplied: record('review.geometry.applied', { topicId: ref, modelId: ref, originalModelId: ref, modelName: ref, path: ref, operation: { enum: operationKinds },
      diagnosis: { type: 'string', minLength: 1 }, beforeHash: hash, afterHash: hash, beforeSource: sourceReference, afterSource: sourceReference, preparedRef: ref,
      before: countSummary, after: countSummary }, ['topicId', 'modelId', 'modelName', 'path', 'operation', 'diagnosis', 'beforeHash', 'afterHash', 'beforeSource', 'afterSource', 'preparedRef', 'before', 'after']),
    geometryVerified: record('review.geometry.verified', { topicId: ref, receiptRef: ref, afterHash: hash, matches: { type: 'boolean' },
      sourceMatches: { type: 'boolean' }, issueVerified: { type: 'boolean' }, canonicalMeshCount: nonnegative, expectedTriangles: nonnegative, loadedTriangles: nonnegative,
      actual: { type: 'array', items: { type: 'object', required: ['path', 'faceCount', 'degenerateCount', 'duplicateCount', 'bounds'], properties: {
        path: ref, faceCount: nonnegative, degenerateCount: nonnegative, duplicateCount: nonnegative,
        bounds: { type: 'object', required: ['min', 'max'], additionalProperties: false, properties: { min: point, max: point } },
      }, additionalProperties: true } } }, ['topicId', 'receiptRef', 'afterHash', 'matches', 'canonicalMeshCount', 'expectedTriangles', 'loadedTriangles', 'actual']),
    geometryResumed: record('review.geometry.resumed', { topicId: ref, receiptRef: ref, sourceHash: hash, modelId: ref }, ['topicId', 'receiptRef', 'sourceHash', 'modelId']),
    geometryUndone: record('review.geometry.undone', { topicId: ref, receiptRef: ref, restoredHash: hash }, ['topicId', 'receiptRef', 'restoredHash']),
  },
  oneOf: ['geometryOperation', 'workflow', 'sourceChunk', 'sourceManifest', 'nativeCall', 'workspaceCall', 'geometryPrepared', 'geometryApplied', 'geometryVerified', 'geometryResumed', 'geometryUndone']
    .map(name => ({ $ref: `#/$defs/${name}` })),
} as const;
