/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createReviewProcess, transitionReviewProcess } from '@/lib/review-companion/process';
import { saveFinding, listFindings } from '@/lib/review-companion/storage';
import type { ReviewContext, ReviewFinding } from '@/lib/review-companion/types';
import { persistReviewProcessSnapshot, readReviewProcessSnapshot, useReviewProcessJournal } from './useReviewProcessJournal';

const at = '2026-10-19T20:00:00.000Z';
const context: ReviewContext = { scopeId: 'fixture:journal-scope', models: [{ id: 'fixture:house', name: 'Fixture house', sourceIdentity: 'sha256:' + 'a'.repeat(64) }], elements: [], capturedAt: at,
  viewpoint: { guid: 'fixture:camera', perspectiveCamera: { cameraViewPoint: { x: 3, y: 4, z: 5 }, cameraDirection: { x: 0, y: 0, z: -1 }, cameraUpVector: { x: 0, y: 1, z: 0 }, fieldOfView: 60 }, snapshot: 'data:image/png;base64,iVBORw0KGgo=' } };
async function persist(row: ReviewFinding) { await saveFinding(row); return row.id; }
function running() {
  const initial = createReviewProcess({ id: crypto.randomUUID(), scopeId: context.scopeId, directive: 'Fixture contract review', models: context.models, createdAt: at });
  return transitionReviewProcess(initial, { kind: 'start', at });
}

test('nonvisual directive completion persists and recovers without becoming an interruption', async () => {
  const directiveContext = { ...context, scopeId: 'fixture:nonvisual-completion' };
  const input: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'note',
    text: 'Fixture raw-value read directive', context: directiveContext, createdAt: at };
  await persist(input);
  let api: ReturnType<typeof useReviewProcessJournal> | undefined;
  function Probe() { api = useReviewProcessJournal(persist); return null; }
  let root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => { await api!.begin(directiveContext, input.text, input.id); });
    await act(async () => { await api!.finish(['fixture:actual-response'], 'directive'); });
    assert.equal(api!.current()!.status, 'directive-completed');
    assert.equal(api!.status, 'Directive completed; no visual inspection performed');
    const complete = api!.current()!;
    const rows = await listFindings(directiveContext.scopeId);
    const snapshot = rows.find(row => {
      try { return JSON.parse(row.text).process?.status === 'directive-completed'; } catch { return false; }
    })!;
    assert.deepEqual(await readReviewProcessSnapshot(snapshot, rows), complete);
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    await act(async () => { await api!.recover(snapshot, rows); });
    assert.deepEqual(api!.current(), complete);
    assert.equal(api!.status, 'Recovered directive completed; no visual inspection performed');
    assert.equal(api!.current()!.events.some(event => event.kind === 'interrupt'), false);
  } finally { await act(async () => root.unmount()); }
});

test('large process snapshots round-trip complete hash-checked chunks in IndexedDB without duplicating screenshots', async () => {
  let process = running();
  for (let i = 0; i < 4; i++) process = transitionReviewProcess(process, { kind: 'inspection', at,
    inspection: { id: `fixture:inspection-${i}`, contextRef: 'fixture:input', viewpointId: context.viewpoint.guid, snapshotRef: 'fixture:input#snapshot', rawResponseRef: `fixture:raw-${i}`, model: 'fixture:Bonsai', summary: 'Visible fixture geometry. '.repeat(250) }, findings: [] });
  const id = await persistReviewProcessSnapshot(process, context, persist);
  const rows = await listFindings(context.scopeId), manifest = rows.find(row => row.id === id)!;
  assert.equal(JSON.parse(manifest.text).kind, 'review.process.manifest');
  assert.equal(rows.every(row => row.text.length <= 50_000 && row.context.viewpoint.snapshot === undefined), true);
  assert.deepEqual(await readReviewProcessSnapshot(manifest, rows), process);
  const missingId = JSON.parse(manifest.text).chunks[0].id;
  await assert.rejects(readReviewProcessSnapshot(manifest, rows.filter(row => row.id !== missingId)), /missing a chunk/);
  const tampered = rows.map(row => row.id === missingId ? { ...row, text: row.text.replace('Visible fixture geometry.', 'Forged fixture geometry.') } : row);
  await assert.rejects(readReviewProcessSnapshot(manifest, tampered), /integrity/);
});

test('journal preserves exact input scope and actual persisted finding IDs through completion', async () => {
  let api: ReturnType<typeof useReviewProcessJournal> | undefined;
  function Probe() { api = useReviewProcessJournal(persist); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => { await api!.begin(context, 'Inspect this fixture.'); });
    assert.equal(api!.current()!.status, 'running');
    const candidates = [{ id: 'fixture:candidate', text: 'Check metadata against supplied evidence.', elements: [], location: { x: 0.5, y: 0.5 } }];
    await act(async () => { await api!.inspection(context, 'fixture:input', 'fixture:raw', 'Fixture window visible.', 'fixture:Bonsai', candidates); });
    const inspected = api!.current()!.events.at(-1)!;
    assert.ok(inspected.kind === 'inspection');
    assert.deepEqual(inspected.findings, [{ id: candidates[0].id, text: candidates[0].text }]);
    assert.equal(api!.canonicalFindingId('fixture:candidate'), 'fixture:candidate');
    assert.equal(api!.canonicalFindingId('unknown'), undefined);
    const child: ReviewFinding = { schemaVersion: 1, id: 'fixture:bound-child', kind: 'candidate', createdAt: at, text: 'Native selected window', context: {
      ...context, elements: [{ modelId: 'fixture:house', expressId: 42, ifcGlobalId: '0abcdefghijklmnopqrstu' }],
    } };
    await act(async () => { await api!.bind('fixture:candidate', child); });
    assert.equal(api!.canonicalFindingId(child.id), 'fixture:candidate');
    assert.equal(api!.current()!.findings[0].element!.expressId, 42);
    await act(async () => { await api!.append({ kind: 'preview', at: new Date().toISOString(), findingId: 'fixture:candidate', preview: { id: 'fixture:preview', digest: 'fixture:digest', mutationVersion: 1, changes: [{ field: 'Name', before: 'Old', after: 'Explicit new name' }], artifactRef: 'fixture:native-preview' } }); });
    await act(async () => { await api!.finish(['fixture:completed-tool-steps']); });
    assert.equal(api!.current()!.status, 'running');
    assert.match(api!.status, /human approval/);
    await act(async () => { await api!.interrupt('Fixture user pause.', ['fixture:steps']); });
    assert.equal(api!.current()!.status, 'interrupted');
    const saved = (await listFindings(context.scopeId)).filter(row => JSON.parse(row.text).kind === 'review.process.snapshot');
    const matching = saved.find(row => JSON.parse(row.text).process.id === api!.current()!.id && JSON.parse(row.text).process.status === 'interrupted')!;
    assert.deepEqual(await readReviewProcessSnapshot(matching, saved), api!.current());
  } finally { await act(async () => root.unmount()); }
});

test('remount recovers an IndexedDB run as interrupted, preserves its real input and binding aliases, and never overrides a fresh run', async () => {
  const recoveryContext = { ...context, scopeId: 'fixture:journal-recovery' };
  const input: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'note', text: 'Fixture original captured input', context: recoveryContext, createdAt: new Date().toISOString() };
  await persist(input);
  let api: ReturnType<typeof useReviewProcessJournal> | undefined;
  function Probe() { api = useReviewProcessJournal(persist); return null; }
  let root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => { await api!.begin(recoveryContext, 'Fixture review before reload', input.id); });
    const original: ReviewFinding = { ...input, id: crypto.randomUUID(), kind: 'candidate', text: 'Fixture candidate', parentId: input.id };
    await persist(original);
    await act(async () => { await api!.inspection(recoveryContext, input.id, 'fixture:recovery-raw', 'Fixture view before reload.', 'fixture:Bonsai', [{ id: original.id, text: original.text }]); });
    const child: ReviewFinding = { ...original, id: crypto.randomUUID(), parentId: original.id, context: { ...recoveryContext, elements: [{ modelId: 'fixture:house', expressId: 42, ifcGlobalId: '0abcdefghijklmnopqrstu' }] } };
    await persist(child);
    await act(async () => { await api!.bind(original.id, child); });
    const beforeReload = api!.current()!;
    const rows = await listFindings(recoveryContext.scopeId);
    const snapshot = rows.find(row => {
      try { const data = JSON.parse(row.text); return data.kind === 'review.process.snapshot' && data.process.id === beforeReload.id && data.process.events.length === beforeReload.events.length; }
      catch { return false; }
    })!;
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    assert.equal(api!.current(), null);
    await act(async () => { await api!.recover(snapshot, rows); });
    assert.equal(api!.current()!.id, beforeReload.id);
    assert.equal(api!.current()!.status, 'interrupted');
    assert.deepEqual(api!.current()!.events.slice(0, -1), beforeReload.events);
    const interruption = api!.current()!.events.at(-1)!;
    assert.equal(interruption.kind, 'interrupt');
    assert.equal('reason' in interruption && interruption.reason, 'Viewer reloaded; incomplete run preserved without automatic continuation');
    assert.equal(api!.canonicalFindingId(child.id), original.id);
    const recoveredRows = await listFindings(recoveryContext.scopeId);
    const persistedRecovery = recoveredRows.find(row => {
      try { const data = JSON.parse(row.text); return data.kind === 'review.process.snapshot' && data.process.id === beforeReload.id && data.process.status === 'interrupted'; }
      catch { return false; }
    })!;
    assert.equal(persistedRecovery.parentId, input.id);
    assert.equal(persistedRecovery.context.viewpoint.snapshot, undefined);
    assert.equal(recoveredRows.find(row => row.id === input.id)!.context.viewpoint.snapshot, recoveryContext.viewpoint.snapshot);
    const count = recoveredRows.length;
    await act(async () => { await api!.recover(snapshot, rows); });
    assert.equal((await listFindings(recoveryContext.scopeId)).length, count);
    await act(async () => { await api!.begin(recoveryContext, 'Fresh owner-requested run', input.id); });
    const freshId = api!.current()!.id;
    await act(async () => { await api!.recover(snapshot, rows); });
    assert.equal(api!.current()!.id, freshId);
    assert.equal(api!.current()!.status, 'running');
  } finally { await act(async () => root.unmount()); }
});
