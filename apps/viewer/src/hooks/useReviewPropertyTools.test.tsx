/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { reviewModels, reviewScope } from '@/lib/review-companion/context';
import { listFindings, saveFinding } from '@/lib/review-companion/storage';
import type { ReviewFinding } from '@/lib/review-companion/types';
import { useReviewPropertyTools } from './useReviewPropertyTools';

// Review companion regression: model tools may propose, but cannot approve their own native edit.
const original = useViewerStore.getState();
const globalId = '0Wall00000000000000101';
const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('review-hook-test.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#101=IFCWALL('${globalId}',$,'W1',$,$,$,$,'T1',$);
ENDSEC;
END-ISO-10303-21;`;
type Api = ReturnType<typeof useReviewPropertyTools>;
let api: Api;
let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  useViewerStore.setState(original);
});

async function setup(persist: (finding: ReviewFinding) => Promise<string> = async finding => {
  await saveFinding(finding); return finding.id;
}) {
  const bytes = new TextEncoder().encode(source);
  const data = await new IfcParser().parseColumnar(bytes.buffer);
  const view = new MutablePropertyView(data.properties, 'A');
  const models = new Map([['A', { ...fixtureModel('A'), ifcDataStore: data,
    sourceContentHash: createHash('sha256').update(bytes).digest('hex') }]]);
  useViewerStore.setState({ models, activeModelId: 'A', ifcDataStore: data,
    mutationViews: new Map([['A', view]]), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), dirtyModels: new Set(), editEnabled: true,
    collabRole: null, collabRoomId: null, mutationVersion: 0 });
  const identities = await reviewModels(models);
  const scope = await reviewScope(identities);
  const finding: ReviewFinding = {
    schemaVersion: 1, id: crypto.randomUUID(), kind: 'note',
    text: 'Owner requests descriptive correction from W1 to Wall 1.',
    createdAt: new Date().toISOString(),
    context: { scopeId: scope, models: identities,
      elements: [{ modelId: 'A', expressId: 101, ifcGlobalId: globalId }],
      capturedAt: new Date().toISOString(), viewpoint: { guid: 'hook-test-view',
        perspectiveCamera: { cameraViewPoint: { x: 4, y: 2, z: 3 },
          cameraDirection: { x: 0, y: 0, z: -1 }, cameraUpVector: { x: 0, y: 1, z: 0 }, fieldOfView: 60 } } },
  };
  await saveFinding(finding);
  function Probe() {
    api = useReviewPropertyTools(scope, persist, undefined);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  const batchJson = JSON.stringify({ version: 1, kind: 'model.changes',
    title: 'Owner requested wall name correction', changes: [{ op: 'attribute.set',
      target: { modelId: 'A', globalId }, name: 'Name', expected: 'W1', value: 'Wall 1' }] });
  return { data, view, finding, scope, batchJson };
}

function tool(name: string) {
  const found = api.tools.find(candidate => candidate.name === name);
  assert.ok(found, `actual hook registers ${name}`);
  return found;
}

async function nameFromExport(data: Awaited<ReturnType<typeof setup>>['data'], view: MutablePropertyView) {
  const exported = editedModelBytes(data, view);
  const parsed = await new IfcParser().parseColumnar(exported.slice().buffer);
  return parsed.entities.getName(parsed.entities.getExpressIdByGlobalId(globalId));
}

test('agent preview is durably recorded before return; agent Apply cannot mutate; owner Apply and Undo round-trip native IFC', async () => {
  const { finding, scope, batchJson, data, view } = await setup();
  let proposed: unknown;
  await act(async () => {
    proposed = await tool('review_preview_changes').execute({ findingId: finding.id, batchJson });
  });
  assert.equal(api.proposals.length, 1);
  const proposal = api.proposals[0];
  assert.equal((proposed as { id: string }).id, proposal.id);
  assert.equal(proposal.preview.rows[0].status, 'ready');
  assert.equal(await nameFromExport(data, view), 'W1');
  assert.equal(useViewerStore.getState().mutationVersion, 0);
  const previewNotes = (await listFindings(scope)).filter(row => row.parentId === finding.id);
  assert.equal(previewNotes.length, 1, 'preview must already exist in actual in-memory IndexedDB');
  const recorded = JSON.parse(previewNotes[0].text);
  assert.equal(recorded.stage, 'property-preview');
  assert.equal(recorded.proposal.id, proposal.id);
  assert.equal(recorded.proposal.batch.changes[0].expected, 'W1');
  assert.equal(recorded.proposal.batch.changes[0].value, 'Wall 1');

  const denied = await tool('review_apply_changes').execute({ previewId: proposal.id });
  assert.equal((denied as { reason: string }).reason, 'owner-approval-required');
  assert.equal((denied as { applied: boolean }).applied, false);
  assert.equal(await nameFromExport(data, view), 'W1');
  assert.equal(api.outcomes.length, 0);
  assert.equal((await listFindings(scope)).filter(row => row.parentId === finding.id).length, 1);

  let applied!: Awaited<ReturnType<Api['apply']>>;
  await act(async () => { applied = await api.apply(proposal); });
  assert.ok('applied' in applied! && applied.applied && applied.ok);
  assert.equal(applied.persisted, true);
  assert.deepEqual(applied.readback, [{ index: 0, field: 'Name', actual: 'Wall 1', matches: true }]);
  assert.equal(await nameFromExport(data, view), 'Wall 1');
  assert.equal(data.entities.getName(101), 'W1', 'parsed source remains immutable');
  assert.equal(api.outcomes.length, 1);
  const applyNotes = (await listFindings(scope)).filter(row => row.parentId === finding.id)
    .map(row => JSON.parse(row.text));
  const applyNote = applyNotes.find(row => row.stage === 'property-apply-readback');
  assert.equal(applyNote.result.receipt.id, applied.receipt.id);
  assert.deepEqual(applyNote.result.readback, applied.readback);

  const appliedReceiptId = applied.receipt.id;
  let undone!: Awaited<ReturnType<Api['undo']>>;
  await act(async () => { undone = await api.undo(proposal, appliedReceiptId); });
  assert.ok('undone' in undone! && undone.undone && undone.ok);
  assert.equal(await nameFromExport(data, view), 'W1');
  const undoNotes = (await listFindings(scope)).filter(row => row.parentId === finding.id)
    .map(row => JSON.parse(row.text)).filter(row => row.stage === 'property-undo');
  assert.equal(undoNotes.length, 1);
  assert.equal(undoNotes[0].result.undone, true);
});

test('failed preview persistence exposes no owner proposal and leaves actual IFC untouched', async () => {
  const { finding, scope, batchJson, data, view } = await setup(async () => {
    throw new Error('Review storage quota refused the preview');
  });
  await act(async () => {
    await assert.rejects(tool('review_preview_changes').execute({ findingId: finding.id, batchJson }), /storage quota refused/);
  });
  assert.equal(api.proposals.length, 0);
  assert.equal(api.outcomes.length, 0);
  assert.equal(await nameFromExport(data, view), 'W1');
  assert.equal(useViewerStore.getState().mutationVersion, 0);
  assert.deepEqual((await listFindings(scope)).filter(row => row.parentId === finding.id), []);
});

test('native stale-preview refusal is retained in the durable owner readback instead of claiming application', async () => {
  const { finding, scope, batchJson, data, view } = await setup();
  await act(async () => { await tool('review_preview_changes').execute({ findingId: finding.id, batchJson }); });
  const proposal = api.proposals[0];
  useViewerStore.setState({ mutationVersion: 1 });
  let refused!: Awaited<ReturnType<Api['apply']>>;
  await act(async () => { refused = await api.apply(proposal); });
  assert.deepEqual(refused!, { ok: false, reason: 'stale' });
  assert.equal(await nameFromExport(data, view), 'W1');
  const notes = (await listFindings(scope)).filter(row => row.parentId === finding.id)
    .map(row => JSON.parse(row.text));
  assert.deepEqual(notes.find(row => row.stage === 'property-apply-readback').result, refused!);
});
