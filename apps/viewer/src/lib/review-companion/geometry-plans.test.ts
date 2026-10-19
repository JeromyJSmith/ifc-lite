/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveGeometryPlan, readGeometryPlan } from './geometry-plans';
import { sha256Hex } from '@/utils/sourceContentHash';
import type { ReviewFinding } from './types';
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer;
const source = () => bytes({ header: { ifcxVersion: 'ifcx_alpha' }, data: [{ path: 'body', attributes: { 'usd::usdgeom::mesh': { points: [[0,0,0],[1,0,0],[0,1,0],[0,0,1]], faceVertexIndices: [0,1,2,0,1,3] } } }] });
const base: ReviewFinding = { schemaVersion: 1, id: 'issue-definition', kind: 'note', text: '', createdAt: '2026-10-19T00:00:00Z', context: { scopeId: 'scope', models: [], elements: [], capturedAt: '2026-10-19T00:00:00Z', viewpoint: { guid: 'view' } } };
test('geometry plan persists exact payload by reference, stays unapplied and binds to its issue', async () => {
  const input = source(), before = input.slice(0), rows: ReviewFinding[] = [];
  const operation = { kind: 'remove_faces', meshPath: 'body', faceIndices: [1] };
  const saved = await saveGeometryPlan(bytes({ sourceHash: await sha256Hex(input), operation }), input, base, 'issue', async row => { rows.push(row); return row.id; });
  assert.equal(saved.applied, false); assert.equal(saved.afterFaces, 1);
  assert.deepEqual(input, before);
  assert.deepEqual((await readGeometryPlan(saved.planRef, 'issue', rows)).operation, operation);
  await assert.rejects(readGeometryPlan(saved.planRef, 'different', rows), /different issue/);
  const chunk = rows.find(r => JSON.parse(r.text).kind === 'review.geometry.source.chunk')!;
  const value = JSON.parse(chunk.text); value.text += ' '; chunk.text = JSON.stringify(value);
  await assert.rejects(readGeometryPlan(saved.planRef, 'issue', rows), /integrity/);
});
test('stale or invalid repair plans fail before any persistence', async () => {
  let saved = 0; const persist = async () => { saved++; return 'bad'; };
  await assert.rejects(saveGeometryPlan(bytes({ sourceHash: 'wrong', operation: {} }), source(), base, 'issue', persist), /different source/);
  await assert.rejects(saveGeometryPlan(bytes({ sourceHash: await sha256Hex(source()), operation: { kind: 'unknown' } }), source(), base, 'issue', persist), /Unknown IFCX/);
  assert.equal(saved, 0);
});
