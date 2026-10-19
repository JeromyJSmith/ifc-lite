/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { IfcParser } from '@ifc-lite/parser';
import { createPickedFinding, type ReviewPickingHost } from './picking';
import { reviewScope } from './context';
import type { ReviewFinding } from './types';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const globalId = '0Wall00000000000000101';
async function fixture() {
  const models = [{ id: 'current-model', name: 'building.ifc', sourceIdentity: `sha256:${'a'.repeat(64)}` }];
  const finding: ReviewFinding = { schemaVersion: 1, id: 'visual-observation', kind: 'candidate',
    text: 'Possible wall surface overlap; inspect it.', location: { x: 0.25, y: 0.75 }, createdAt: '2026-10-19T10:00:00Z',
    context: { models: [{ ...models[0], id: 'old-load-id' }], scopeId: await reviewScope(models), elements: [], capturedAt: '2026-10-19T10:00:00Z',
      viewpoint: { guid: 'saved-view', snapshot: 'data:image/png;base64,YQ==', perspectiveCamera: {
        cameraViewPoint: { x: 1, y: 2, z: 3 }, cameraDirection: { x: 0, y: 0, z: -1 }, cameraUpVector: { x: 0, y: 1, z: 0 }, fieldOfView: 60, aspectRatio: 2,
      } } } };
  const calls: unknown[] = [];
  const host: ReviewPickingHost = {
    restore: async viewpoint => { calls.push(['restore', viewpoint.guid]); },
    frame: () => ({ width: 800, height: 400, signature: 'camera+culling+cuts+revision:1' }),
    pick: async (x, y) => { calls.push(['pick', x, y]); return { expressId: 1042 }; },
    currentModels: async () => structuredClone(models),
    resolvePick: async rendererId => { calls.push(['resolve', rendererId]); return { modelId: 'current-model', expressId: 42, ifcGlobalId: globalId }; },
  };
  return { finding, models, host, calls };
}

test('saved normalized screenshot point resolves through native hit into a new child without rewriting the observation', async () => {
  const { finding, host, calls } = await fixture();
  const before = structuredClone(finding);
  const child = await createPickedFinding(finding, host);
  assert.deepEqual(calls, [['restore', 'saved-view'], ['pick', 200, 300], ['resolve', 1042]]);
  assert.notEqual(child.id, finding.id); assert.equal(child.parentId, finding.id);
  assert.deepEqual(child.context.elements, [{ modelId: 'current-model', expressId: 42, ifcGlobalId: globalId }]);
  assert.deepEqual(child.context.viewpoint.components?.selection, [{ ifcGuid: globalId }]);
  assert.equal(child.context.viewpoint.snapshot, finding.context.viewpoint.snapshot);
  assert.equal(child.context.capturedAt, finding.context.capturedAt, 'original screenshot timestamp is preserved');
  assert.equal(child.kind, 'candidate', 'picking identifies an object, not a confirmed defect');
  assert.deepEqual(finding, before);
});

test('native default resolver distinguishes federation renderer IDs from actual model-local express IDs and verifies GUID', async () => {
  const { finding, host, models } = await fixture();
  const source = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('pick-test.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);\n#42=IFCWALL('${globalId}',$,'Wall',$,$,$,$,'T1',$);\nENDSEC;\nEND-ISO-10303-21;`;
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
  const other = { id: 'other-model', name: 'other.ifc', sourceIdentity: `sha256:${'b'.repeat(64)}` };
  host.currentModels = async () => [other, ...models];
  finding.context.models.unshift(other);
  finding.context.scopeId = await reviewScope([other, ...models]);
  useViewerStore.setState({ models: new Map([
    ['other-model', { ...fixtureModel('other-model', { idOffset: 0 }), maxExpressId: 100, ifcDataStore: data }],
    ['current-model', { ...fixtureModel('current-model', { idOffset: 1000 }), maxExpressId: 100, ifcDataStore: data }],
  ]),
    ifcDataStore: data, mutationViews: new Map() });
  delete host.resolvePick;
  const child = await createPickedFinding(finding, host);
  assert.deepEqual(child.context.elements, [{ modelId: 'current-model', expressId: 42, ifcGlobalId: globalId }]);
});

test('wrong source, missing aspect and incompatible viewport refuse picking', async () => {
  const { finding, host, calls } = await fixture();
  const wrong = structuredClone(finding); wrong.context.scopeId = 'review:wrong';
  await assert.rejects(createPickedFinding(wrong, host), /exact reviewed model revisions/);
  const noAspect = structuredClone(finding); delete noAspect.context.viewpoint.perspectiveCamera!.aspectRatio;
  await assert.rejects(createPickedFinding(noAspect, host), /no camera aspect ratio/);
  host.frame = () => ({ width: 400, height: 400, signature: 'square viewport' });
  await assert.rejects(createPickedFinding(finding, host), /aspect ratio differs/);
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'pick'), false);
});

test('camera, visibility or clipping signature changes during asynchronous picking prevent attribution', async () => {
  const { finding, host } = await fixture();
  let frame = 1;
  host.frame = () => ({ width: 800, height: 400, signature: `camera-and-cuts:${frame}` });
  host.pick = async () => { frame++; return { expressId: 1042 }; };
  await assert.rejects(createPickedFinding(finding, host), /frame changed while picking/);
});

test('model reload during pick refuses even when exact source bytes and scope remain unchanged', async () => {
  const { finding, host, models } = await fixture();
  let calls = 0;
  host.currentModels = async () => ++calls === 1 ? models : [{ ...models[0], id: 'new-load-id' }];
  await assert.rejects(createPickedFinding(finding, host), /model or viewer frame changed/);
});

test('background hits and unresolved native identity remain unbound', async () => {
  const { finding, host } = await fixture();
  host.pick = async () => null;
  await assert.rejects(createPickedFinding(finding, host), /No IFC element was hit/);
  host.pick = async () => ({ expressId: 1042 }); host.resolvePick = async () => null;
  await assert.rejects(createPickedFinding(finding, host), /no exact IFC model/);
  host.resolvePick = async () => ({ modelId: 'unloaded-model', expressId: 42, ifcGlobalId: globalId });
  await assert.rejects(createPickedFinding(finding, host), /no exact IFC model/);
});

test('invalid point and cancellation cannot create a guessed element association', async () => {
  const { finding, host, calls } = await fixture();
  await assert.rejects(createPickedFinding({ ...finding, location: { x: 1.1, y: 0.5 } }, host), /valid normalized screenshot point/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createPickedFinding(finding, host, controller.signal), { name: 'AbortError' });
  assert.deepEqual(calls, []);
});

test('native surface evidence survives binding without mutating the original and rejects nonfinite hits', async () => {
  const { finding, host } = await fixture();
  const surfaceHit = { point: { x: 1.25, y: -2, z: 3.5 }, triangleIndex: 19, coordinateSpace: 'rendered-viewer-world' as const };
  host.pick = async () => ({ expressId: 1042, surfaceHit });
  const bound = await createPickedFinding(finding, host);
  assert.deepEqual(bound.surfaceHit, surfaceHit);
  surfaceHit.point.x = 99;
  assert.equal(bound.surfaceHit?.point.x, 1.25);
  assert.equal(finding.surfaceHit, undefined);
  surfaceHit.point.z = NaN;
  await assert.rejects(createPickedFinding(finding, host), /surface location/);
});
