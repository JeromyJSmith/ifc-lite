/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveIssueViewpoint } from './issue-viewpoint';
import type { ReviewContext, ReviewFinding } from './types';
const sourceHash = 'a'.repeat(64), binding = { modelId: 'model', sourceHash, sourceIdentity: 'sha256:placement-sha256-1m-v1:placed-model', receiptRef: 'repair' };
function setup() {
  const context: ReviewContext = { scopeId: 'after', capturedAt: new Date().toISOString(),
    models: [{ id: 'model', name: 'Repaired model', sourceIdentity: binding.sourceIdentity }], elements: [],
    viewpoint: { guid: 'actual-view', snapshot: 'actual-pixels' } };
  const rows: ReviewFinding[] = [], order: string[] = [];
  return { context, rows, order, options: { topicId: 'topic', note: 'Repaired view', binding,
    capture: async () => { order.push('capture'); return structuredClone(context); },
    qualify: async () => { order.push('qualify'); },
    persist: async (row: ReviewFinding) => { order.push('persist'); rows.push(structuredClone(row)); return row.id; },
    install: async () => { order.push('install'); return true; } } };
}
test('actual source-bound after-view persists before native installation and retains its image', async () => {
  const s = setup(), result = await saveIssueViewpoint(s.options);
  assert.deepEqual(s.order, ['capture', 'qualify', 'persist', 'install']);
  assert.equal(result.saved, true); assert.equal(result.receiptRef, 'repair'); assert.equal(result.sourceHash, sourceHash);
  assert.equal(result.viewpointRef, s.rows[0].id); assert.deepEqual(s.rows[0].context, s.context);
  assert.equal(JSON.parse(s.rows[0].text).receiptRef, 'repair');
  assert.equal(JSON.parse(s.rows[0].text).sourceIdentity, binding.sourceIdentity);
});
test('missing image, wrong captured source and a concurrent source change never install an after-view', async () => {
  for (const failure of ['image', 'source', 'concurrent']) {
    const s = setup();
    if (failure === 'image') s.context.viewpoint.snapshot = undefined;
    if (failure === 'source') s.context.models[0].sourceIdentity = `sha256:${'b'.repeat(64)}`;
    if (failure === 'concurrent') s.options.qualify = async () => { throw new Error('Source changed'); };
    await assert.rejects(saveIssueViewpoint(s.options));
    assert.equal(s.rows.length, 0); assert.ok(!s.order.includes('install'));
  }
});
test('failed persistence or native readback cannot report a successfully attached image', async () => {
  const storage = setup(); storage.options.persist = async () => { throw new Error('Disk unavailable'); };
  await assert.rejects(saveIssueViewpoint(storage.options), /Disk unavailable/); assert.ok(!storage.order.includes('install'));
  const identity = setup(); identity.options.persist = async () => 'wrong-row';
  await assert.rejects(saveIssueViewpoint(identity.options), /different identity/); assert.ok(!identity.order.includes('install'));
  const native = setup(); native.options.install = async () => false;
  await assert.rejects(saveIssueViewpoint(native.options), /saved row remains recoverable/); assert.equal(native.rows.length, 1);
});
