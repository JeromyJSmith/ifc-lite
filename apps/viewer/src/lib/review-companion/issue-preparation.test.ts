/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureModel } from '@/test/store-fixture';
import { createReviewTool } from './tools';
import { inspectIfcxGeometry } from './ifcx-geometry';
import { prepareSavedIssue, type IssuePreparationOptions } from './issue-preparation';
import type { ReviewContext } from './types';
function setup(abort: AbortController, cancelAt?: string) {
  const events: string[] = [];
  const context: ReviewContext = { scopeId: 'scope', models: [{ id: 'original', name: 'Building', sourceIdentity: 'sha256:source' }], elements: [
    { modelId: 'original', expressId: 1, ifcGlobalId: 'wall' }, { modelId: 'original', expressId: 1, ifcGlobalId: 'wall' }], capturedAt: '2026-10-19T10:00:00Z', viewpoint: { guid: 'view' } };
  const models = new Map([['live', { ...fixtureModel('live'), sourceContentHash: 'source' }]]);
  const source = new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx_alpha' }, imports: [], schemas: {}, data: [
    { path: 'wall', children: { Body: 'body' }, attributes: { 'bsi::ifc::class': { code: 'IfcWall' } } },
    { path: 'body', attributes: { 'usd::usdgeom::mesh': { points: [[0,0,0],[1,0,0],[0,1,0],[2,0,0]], faceVertexIndices: [0,1,2,1,2,0,0,1,3] } } },
  ] })).buffer;
  const options: IssuePreparationOptions = { workflow: { list: async () => [{ topicId: 'issue', context }], investigate: async () => { events.push('restore'); if (cancelAt === 'restore') abort.abort(); } },
    geometryTool: createReviewTool('review_geometry_inspect', 'Exact source', { modelId:{type:'string'},path:{type:'string'} }, true, args => {
      events.push(`geometry:${args.modelId}:${args.path}`); const report = inspectIfcxGeometry(source, args.path as string); return { ...report, sourceHash:'exact-hash',candidateId:'candidate',evidenceRef:'geometry-evidence' };
    }), inspect: async signal => { signal.throwIfAborted(); events.push('visual'); if (cancelAt === 'visual') abort.abort(); }, models: () => models,
    onStatus: () => {} };
  return { options, events };
}
test('saved issue preparation measures real IFCX topology once per uniquely bound surrounding element', async () => {
  const abort = new AbortController(), s = setup(abort);
  const reports = await prepareSavedIssue(s.options, 'issue', abort.signal);
  assert.deepEqual(s.events, ['restore','visual','geometry:live:wall']);
  assert.deepEqual(reports, [{modelId:'live',sourceHash:'exact-hash',candidateId:'candidate',evidenceRef:'geometry-evidence',meshes:[{path:'body',faceCount:3,degenerateCount:1,duplicateCount:1,defectiveFaceCount:2}]}]);

});
test('cancel after restoration prevents inspection and geometry reads', async () => {
  const abort = new AbortController(), s = setup(abort,'restore');
  await assert.rejects(prepareSavedIssue(s.options,'issue',abort.signal), /abort/i);
  assert.deepEqual(s.events,['restore']);
});
test('cancel during visual inspection prohibits geometry tools; initial cancel prohibits restoration', async () => {
  const abort = new AbortController(), s = setup(abort,'visual');
  await assert.rejects(prepareSavedIssue(s.options,'issue',abort.signal), /abort/i);
  assert.deepEqual(s.events,['restore','visual']);
  const early = new AbortController(), before = setup(early); early.abort();
  await assert.rejects(prepareSavedIssue(before.options,'issue',early.signal), /abort/i); assert.deepEqual(before.events,[]);
});
