/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPropertyTools, type PropertyToolHandlers } from './property-tools';

function fixture() {
  const calls: unknown[] = [];
  const handlers: PropertyToolHandlers = {
    readElement: async input => { calls.push(input); return { modelId: input.modelId, expressId: input.expressId, properties: [{ name: 'IsExternal', value: false }] }; },
    previewChanges: async input => { calls.push(input); return { previewId: 'preview-1', rows: [{ expected: false, value: true }] }; },
    applyChanges: async input => { calls.push(input); return { receiptId: 'receipt-1', before: false, after: true }; },
    undoChanges: async input => { calls.push(input); return { undone: true, after: false }; },
  };
  const tools = createPropertyTools(handlers);
  const execute = (name: string, input: unknown, signal?: AbortSignal) => tools.find(tool => tool.name === name)!.execute(input, { signal });
  return { calls, tools, execute };
}
const batch = {
  version: 1, kind: 'model.changes', title: 'Correct explicit property',
  changes: [{ op: 'property.set', target: { globalId: '0abcdefghijklmnopqrstu', modelId: 'house' }, pset: 'Pset_WallCommon', name: 'IsExternal', expected: false, value: true, dataType: 'IfcBoolean' }],
};

test('read, typed native preview, apply and undo dispatch exact bounded identities and scalar values', async () => {
  const { calls, execute } = fixture();
  assert.deepEqual(await execute('review_read_element', { modelId: 'house', expressId: 42 }), { modelId: 'house', expressId: 42, properties: [{ name: 'IsExternal', value: false }] });
  assert.deepEqual(await execute('review_preview_changes', { findingId: 'finding-1', batchJson: JSON.stringify(batch) }), { previewId: 'preview-1', rows: [{ expected: false, value: true }] });
  assert.deepEqual(calls[1], { findingId: 'finding-1', batch });
  assert.deepEqual(await execute('review_apply_changes', { previewId: 'preview-1' }), { receiptId: 'receipt-1', before: false, after: true });
  assert.deepEqual(await execute('review_undo_changes', { receiptId: 'receipt-1' }), { undone: true, after: false });
  assert.deepEqual(calls.slice(2), [{ previewId: 'preview-1' }, { receiptId: 'receipt-1' }]);
});

test('native parser refuses invented operations, absent expected values, invalid typed scalars and unqualified targets before preview handler', async () => {
  const { calls, execute } = fixture();
  const base = batch.changes[0];
  const invalid = [
    { ...base, op: 'execute.javascript', value: 'window.eval()' },
    { ...base, expected: undefined },
    { ...base, target: { globalId: base.target.globalId } },
    { ...base, target: { modelId: 'house', globalId: 'invalid\npath' } },
    { ...base, value: 'true', dataType: 'IfcBoolean' },
    { op: 'attribute.set', target: base.target, name: 'GlobalId', expected: base.target.globalId, value: 'replacement' },
  ];
  for (const change of invalid) await assert.rejects(execute('review_preview_changes', { findingId: 'finding-1', batchJson: JSON.stringify({ ...batch, changes: [change] }) }));
  assert.deepEqual(calls, []);
});

test('tool schema rejects arbitrary apply payloads, excessive JSON, invalid IDs and canceled writes', async () => {
  const { calls, execute } = fixture();
  await assert.rejects(execute('review_apply_changes', { previewId: 'preview-1', force: true }), /unknown/);
  await assert.rejects(execute('review_apply_changes', { batchJson: JSON.stringify(batch) }), /unknown/);
  await assert.rejects(execute('review_preview_changes', { findingId: 'finding-1', batchJson: 'x'.repeat(16001) }), /batchJson/);
  await assert.rejects(execute('review_read_element', { modelId: 'house', expressId: 0 }), /expressId/);
  await assert.rejects(execute('review_undo_changes', { receiptId: '' }), /receiptId/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(execute('review_apply_changes', { previewId: 'preview-1' }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(calls, []);
});
