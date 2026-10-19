/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readBCF, writeBCF } from '@ifc-lite/bcf';
import { parseIfcxViewerModel } from '@/hooks/ingest/viewerModelIngest';
import { resolveGlobalId } from '@/lib/actions/resolve-global-id';
import { resolveIfcxViewpointComponents } from '@/hooks/bcf/ifcx-components';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { createReviewBcfBridge, createBcfReviewTools } from './bcf';
import { reviewModels, reviewScope } from './context';
import type { ReviewFinding } from './types';
const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const path = '87bc53eb-9867-5bce-b504-5ba41011afb2';
async function setup(selected = true) {
  const bytes = new TextEncoder().encode(JSON.stringify({ header: { ifcxVersion: 'ifcx-alpha' }, imports: [], schemas: {}, data: [
    { path, attributes: { 'bsi::ifc::class': { code: 'IfcWall' }, 'bsi::ifc::prop::Name': 'Surrounding wall' } },
    { path: `${path}-material`, attributes: { 'bsi::ifc::class': { code: 'IfcMaterial' } } },
  ] }));
  const parsed = await parseIfcxViewerModel(bytes.buffer, undefined, { allowEmptyGeometry: true });
  const model = { ...fixtureModel('A'), schemaVersion: 'IFC5' as const, ifcDataStore: parsed.dataStore, maxExpressId: 2, sourceContentHash: 'a'.repeat(64) };
  const models = new Map([['A', model]]);
  useViewerStore.setState({ models, mutationViews: new Map(), bcfProject: null, mutationVersion: 0 });
  const sources = await reviewModels(models), scope = await reviewScope(sources);
  const finding: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'candidate', text: 'Possible unclosed opening; the selected wall is surrounding context, not the missing piece.', createdAt: new Date().toISOString(),
    context: { scopeId: scope, models: sources, elements: selected ? [{ modelId: 'A', expressId: 1, ifcGlobalId: path }] : [], capturedAt: new Date().toISOString(),
      viewpoint: { guid: crypto.randomUUID(), snapshot: 'data:image/png;base64,iVBORw0KGgo=', perspectiveCamera: {
        cameraViewPoint: { x: 1, y: 2, z: 3 }, cameraDirection: { x: 0, y: 1, z: 0 }, cameraUpVector: { x: 0, y: 0, z: 1 }, fieldOfView: 60,
      }, components: { selection: selected ? [{ ifcGuid: path }] : [] } } } };
  const rows = [finding];
  const bridge = createReviewBcfBridge({ scope: () => scope, rows: async () => structuredClone(rows), persist: async row => { rows.push(structuredClone(row)); return row.id; } });
  return { finding, rows, bridge, models };
}
test('IFCX path resolution uses real parsed columns rather than requiring nonexistent STEP records', async () => {
  await setup();
  assert.deepEqual(resolveGlobalId(useViewerStore.getState(), { modelId: 'A', globalId: path }), { modelId: 'A', expressId: 1 });
  assert.equal(resolveGlobalId(useViewerStore.getState(), { modelId: 'A', globalId: `${path}-material` }), 'missing', 'IFCX resources cannot masquerade as Root elements');
});
test('surrounding-context BCF issue persists before installation, roundtrips with snapshot and restores authoring IDs', async () => {
  const { finding, bridge, rows, models } = await setup();
  const result = await bridge.create({ findingId: finding.id, title: 'Check possible wall opening', description: 'Inspect the visible unclosed region; dimensions are unknown.' });
  assert.equal(result.saved, true); assert.equal(result.contextElementCount, 1); assert.equal(result.hasSnapshot, true);
  const project = useViewerStore.getState().bcfProject!;
  assert.equal(project.topics.size, 1); assert.equal(rows.length, 3);
  const topic = project.topics.get(result.topicId)!;
  assert.equal(topic.topicStatus, 'Open'); assert.match(topic.description!, /surrounding context/);
  assert.deepEqual(topic.viewpoints[0].components?.selection, [{ authoringToolId: path, originatingSystem: 'IFC-Lite IFCX' }]);
  const archive = await writeBCF(project), restored = await readBCF(archive);
  const vp = restored.topics.get(result.topicId)!.viewpoints[0];
  assert.equal(vp.snapshot, finding.context.viewpoint.snapshot);
  assert.equal(resolveIfcxViewpointComponents(vp, models).components?.selection?.[0].ifcGuid, path);
  assert.equal(resolveIfcxViewpointComponents(vp, new Map([...models, ['B', { ...models.get('A')!, id: 'B' }]])).components?.selection?.[0].ifcGuid, undefined, 'ambiguous prim paths are not assigned to the first model');
  const duplicate = await bridge.create({ findingId: finding.id, title: 'Do not duplicate', description: 'Repeated request' });
  assert.equal(duplicate.topicId, result.topicId); assert.equal(useViewerStore.getState().bcfProject!.topics.size, 1);
  useViewerStore.getState().setBcfProject(null);
  await bridge.open(result.topicId);
  assert.equal(useViewerStore.getState().bcfProject!.topics.size, 1, 'saved definition restores after native project closes');
});
test('a hole can have a viewpoint-only BCF issue without inventing an element', async () => {
  const { finding, bridge } = await setup(false);
  const issue = await bridge.create({ findingId: finding.id, title: 'Review missing closure', description: 'Only the viewpoint identifies this region.' });
  assert.equal(issue.contextElementCount, 0);
  assert.deepEqual(useViewerStore.getState().bcfProject!.topics.get(issue.topicId)!.viewpoints[0].components?.selection, []);
});
test('failed durable save creates no native topic; source mismatch refuses restoration', async () => {
  const { finding, bridge, rows } = await setup();
  const failing = createReviewBcfBridge({ scope: () => finding.context.scopeId, rows: async () => rows, persist: async () => { throw new Error('storage refused'); } });
  await assert.rejects(failing.create({ findingId: finding.id, title: 'Review', description: 'Check' }), /storage refused/);
  assert.equal(useViewerStore.getState().bcfProject, null);
  const created = await bridge.create({ findingId: finding.id, title: 'Review', description: 'Check' });
  useViewerStore.setState({ models: new Map() });
  await assert.rejects(bridge.open(created.topicId), /reviewed model revision|Load a building model/);
});
test('WebMCP tools expose bounded local BCF creation, list and open without publication', async () => {
  const { bridge, finding } = await setup(); const tools = createBcfReviewTools(bridge);
  assert.deepEqual(tools.map(tool => tool.name), ['review_create_bcf_issue', 'review_bcf_issues', 'review_open_bcf_issue']);
  await assert.rejects(tools[0].execute({ findingId: finding.id, title: 'Review', description: 'Check', publish: true }), /unknown tool argument/);
  const result = await tools[0].execute({ findingId: finding.id, title: 'Review', description: 'Check' }) as { topicId: string };
  assert.ok(result.topicId); assert.equal((await bridge.list()).length, 1);
});
