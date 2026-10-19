/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import type { FederatedModel } from '@/store/types';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { registerViewportCapture } from '@/lib/viewport-capture';
import { listFindings } from '@/lib/review-companion/storage';
import { setGlobalCanvasRef, setGlobalRendererRef } from './useBCF';
import { useReviewCompanion } from './useReviewCompanion';

const guid = '0abcdefghijklmnopqrstu';
const image = 'data:image/png;base64,iVBORw0KGgo=';
const position = { x: 30, y: 20, z: 25 }, target = { x: 1, y: 2, z: 3 };
let applied: { position: typeof position; target: typeof target } | undefined;
let renders = 0;
let gpuCompletion: Promise<void> | null = null;
const renderer = {
  getCamera: () => ({
    getPosition: () => position, getTarget: () => target, getUp: () => ({ x: 0, y: 1, z: 0 }),
    getFOV: () => Math.PI / 4, getAspect: () => 16 / 9, getDistance: () => Math.hypot(29, 18, 22),
    animateTo: (p: typeof position, t: typeof target) => { applied = { position: p, target: t }; },
  }),
  renderWithResult: () => { renders++; return true; },
  getGPUDevice: () => gpuCompletion ? { queue: { onSubmittedWorkDone: () => gpuCompletion } } : null,
  requestRender: () => {},
} as unknown as Renderer;
function model(id: string, revision = 'a'): FederatedModel {
  return { ...fixtureModel(id, { entities: [{ expressId: 42, type: 'IfcWindow', globalId: guid }] }), maxExpressId: 100, sourceContentHash: revision.repeat(64) };
}
let root: Root | undefined, api: ReturnType<typeof useReviewCompanion> | undefined, unregister: (() => void) | undefined;
function Probe() { api = useReviewCompanion(false); return null; }
async function mount() {
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Probe />));
  // Scope hashing and IndexedDB transactions are real asynchronous work.
  for (let i = 0; i < 100 && !api?.scope; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.match(api!.scope, /^review:[0-9a-f]{64}$/);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}
beforeEach(() => {
  renders = 0; applied = undefined; gpuCompletion = null;
  useViewerStore.setState({ ...fixtureModels(model('original-load')), selectedEntityId: 42, selectedEntityIds: new Set([42]),
    hiddenEntities: new Set(), isolatedEntities: null, clashHighlightColors: null, geometryResult: null,
    activeTool: 'select', sectionPlane: { ...useViewerStore.getState().sectionPlane, enabled: false, custom: undefined },
  });
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'toDataURL', { value: () => image });
  setGlobalCanvasRef({ current: canvas }); setGlobalRendererRef({ current: renderer });
  unregister = registerViewportCapture(renderer, canvas, () => ({}));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; api = undefined; unregister?.();
  setGlobalCanvasRef({ current: null }); setGlobalRendererRef({ current: null });
});

test('a note persists exact source identity, element, owned screenshot and camera across remount and reload IDs', async () => {
  await mount();
  const scope = api!.scope;
  let id = '';
  await act(async () => { id = (await api!.note('Check the selected window sill.')).id; });
  const finding = (await listFindings(scope)).find(row => row.id === id)!;
  assert.equal(finding.text, 'Check the selected window sill.');
  assert.deepEqual(finding.context.models, [{ id: 'original-load', name: 'original-load', sourceIdentity: `sha256:${'a'.repeat(64)}` }]);
  assert.deepEqual(finding.context.elements, [{ modelId: 'original-load', expressId: 42, ifcGlobalId: guid }]);
  assert.equal(finding.context.viewpoint.snapshot, image);
  assert.deepEqual(finding.context.viewpoint.components?.selection, [{ ifcGuid: guid }]);
  assert.deepEqual(finding.context.viewpoint.perspectiveCamera?.cameraViewPoint, { x: 30, y: -25, z: 20 });
  assert.equal(renders, 1);
  await act(async () => root!.unmount()); root = undefined;
  useViewerStore.setState({ ...fixtureModels(model('reopened-load')), selectedEntityId: null, selectedEntityIds: new Set() });
  await mount();
  for (let i = 0; i < 100 && !api!.findings.some(row => row.id === id); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.equal(api!.scope, scope);
  await act(async () => { await api!.restore(id); });
  assert.deepEqual(useViewerStore.getState().selectedEntity, { modelId: 'reopened-load', expressId: 42 });
  assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [42]);
  assert.equal(useViewerStore.getState().selectedEntityId, 42);
  assert.deepEqual(applied?.position, position);
  for (const axis of ['x', 'y', 'z'] as const) assert.ok(Math.abs(applied!.target[axis] - target[axis]) < 1e-9);
});

test('replacing models while GPU readback is pending refuses a mixed-revision note', async () => {
  await mount();
  const scope = api!.scope, count = (await listFindings(scope)).length;
  let complete!: () => void;
  gpuCompletion = new Promise<void>(resolve => { complete = resolve; });
  await act(async () => {
    const note = api!.note('This observation must not acquire another model identity.');
    const rejected = assert.rejects(note, /view changed|captur/i);
    for (let i = 0; i < 100 && renders === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(renders, 1);
    useViewerStore.setState(fixtureModels(model('replacement-during-capture', 'c')));
    complete();
    await rejected;
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal((await listFindings(scope)).length, count);
});

test('no screenshot means no fabricated saved note, while model revision mismatch prevents restore', async () => {
  await mount();
  let id = '';
  await act(async () => { id = (await api!.note('Preserve this actual captured view.')).id; });
  const scope = api!.scope, count = (await listFindings(scope)).length;
  setGlobalRendererRef({ current: null });
  await act(async () => { await assert.rejects(api!.note('This has no frame.'), /view changed|captur/i); });
  assert.equal((await listFindings(scope)).length, count);
  setGlobalRendererRef({ current: renderer });
  await act(async () => { useViewerStore.setState(fixtureModels(model('different-revision', 'b'))); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await act(async () => { api!.setHistoryScope(scope); });
  for (let i = 0; i < 100 && !api!.findings.some(row => row.id === id); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  applied = undefined;
  await act(async () => { await assert.rejects(api!.restore(id), /same model revision/); });
  assert.equal(applied, undefined);
});
