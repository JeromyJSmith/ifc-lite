/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { directiveEvidence } from './directive-evidence';
import type { ReviewContext } from './types';
const context: ReviewContext = { scopeId: 'current', capturedAt: '2026-10-19T16:00:00Z', mutationVersion: 4,
  models: [{ id: 'loaded-A', name: 'Building A', sourceIdentity: 'sha256:a' }, { id: 'loaded-B', name: 'Building B', sourceIdentity: 'sha256:b' }],
  elements: [{ modelId: 'loaded-B', expressId: 53, ifcGlobalId: 'element' }], viewpoint: { guid: 'view', snapshot: 'large-image' } };
test('current single or federated native identities are supplied without the captured image', () => {
  const result = directiveEvidence(context);
  assert.deepEqual(result.currentViewer.models.map(m => m.id), ['loaded-A', 'loaded-B']);
  assert.deepEqual(result.currentViewer.selectedElements, context.elements);
  assert.equal(result.currentViewer.mutationVersion, 4);
  assert.equal(JSON.stringify(result).includes('large-image'), false);
  assert.equal(directiveEvidence({ ...context, models: [context.models[0]] }).currentViewer.models[0].id, 'loaded-A');
});
test('supplied issue evidence cannot replace actual native model identities', () => {
  const supplied = { currentViewer: { models: [{ id: 'invented' }] }, issue: { topicId: 'chosen' } };
  const result = directiveEvidence(context, supplied);
  assert.equal(result.currentViewer.models[0].id, 'loaded-A');
  assert.deepEqual(result.savedIssueEvidence, supplied);
});
