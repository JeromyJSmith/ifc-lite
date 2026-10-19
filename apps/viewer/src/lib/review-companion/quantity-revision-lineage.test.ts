/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { exportSourceQuantityEdits } from '@ifc-lite/export';
import { parseIfcxViewerModel } from '@/hooks/ingest/viewerModelIngest';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import { sha256Hex } from '@/utils/sourceContentHash';
import { saveGeometrySource } from './geometry-sources';
import { verifiedQuantityPredecessors } from './quantity-revision-lineage';
import type { ReviewFinding } from './types';

async function fixture() {
  const bytes = new TextEncoder().encode(JSON.stringify({
    header: { id: 'lineage-fixture', ifcxVersion: 'ifcx_alpha', dataVersion: '1' }, imports: [], schemas: {},
    data: [{ path: 'wall', attributes: { 'bsi::ifc::class': { code: 'IfcWall' },
      'bsi::ifc::v5a::Qto_WallBaseQuantities::NetVolume': 3,
      'usd::usdgeom::mesh': { points: [[0,0,0],[1,0,0],[0,0,1]], faceVertexCounts: [3], faceVertexIndices: [0,1,2] },
    } }],
  })).buffer;
  const identity = `sha256:${await placementSourceIdentity(new Blob([bytes]), undefined, new Uint8Array(bytes))}`;
  const context = { scopeId: 'scope', models: [{ id: 'old', name: 'source.ifcx', sourceIdentity: identity }],
    elements: [{ modelId: 'old', expressId: 1, ifcGlobalId: 'wall' }], viewpoint: { guid: 'view' }, capturedAt: '2026-10-19T10:00:00Z' };
  const row = (id: string, data: unknown): ReviewFinding => ({ schemaVersion: 1, id, kind: 'note', parentId: 'issue', context,
    createdAt: context.capturedAt, text: JSON.stringify(data) });
  const rows: ReviewFinding[] = [];
  await saveGeometrySource(bytes, row('base', {}), async entry => { rows.push(entry); return entry.id; });
  const change = { op: 'quantity.set', target: { modelId: 'session', globalId: 'wall' }, qset: 'Qto_WallBaseQuantities', name: 'NetVolume', expected: 3, value: 4 };
  rows.push(row('preview', { stage: 'property-preview', proposal: { id: 'preview-id', findingId: 'issue', preview: { digest: 'digest' }, batch: { changes: [change] } } }),
    row('approval', { stage: 'property-owner-approval', previewId: 'preview-id', digest: 'digest', method: 'native-review-click' }),
    row('readback', { stage: 'property-apply-readback', result: { ok: true, applied: true, persisted: true,
      receipt: { status: 'applied', digest: 'digest', origin: 'review:issue', skipped: [], applied: [{ index: 0, op: change.op, modelId: 'session', globalId: 'wall', field: 'Qto_WallBaseQuantities.NetVolume', before: 3, after: 4 }] },
      readback: [{ index: 0, field: 'Qto_WallBaseQuantities.NetVolume', actual: 4, matches: true }] } }));
  const parsed = await parseIfcxViewerModel(bytes);
  const view = new MutablePropertyView(parsed.dataStore.properties, 'session');
  view.setQuantityExtractor(id => parsed.dataStore.quantities.getForEntity(id));
  const id = parsed.dataStore.entities.getExpressIdByGlobalId('wall');
  const quantity = view.getQuantitiesForEntity(id)[0].quantities[0];
  view.setQuantity(id, change.qset, change.name, 4, quantity.type);
  const saved = exportSourceQuantityEdits(parsed.dataStore, view)!;
  assert.ok(saved);
  const target = { id: 'current', hash: await sha256Hex(new TextEncoder().encode(saved).buffer) };
  return { rows, target, identity, bytes };
}

test('exact native quantity export retains its verified source ancestry across reload', async () => {
  const f = await fixture();
  const result = await verifiedQuantityPredecessors(f.rows, [f.target]);
  assert.ok(result.get('current')?.identities.has(f.identity));
  assert.ok(result.get('current')?.hashes.has((await sha256Hex(f.bytes))!));
  assert.deepEqual([...result.get('current')!.receiptRefs], ['readback']);
});
test('missing approval, corrupt source, wrong readback and changed target cannot qualify lineage', async () => {
  const f = await fixture();
  for (const missing of ['approval', 'preview', 'readback', f.rows[0].id]) {
    assert.equal((await verifiedQuantityPredecessors(f.rows.filter(row => row.id !== missing), [f.target])).size, 0);
  }
  const corrupt = structuredClone(f.rows);
  const row = corrupt.find(row => row.id === 'readback')!;
  const data = JSON.parse(row.text); data.result.readback[0].actual = 99; row.text = JSON.stringify(data);
  assert.equal((await verifiedQuantityPredecessors(corrupt, [f.target])).size, 0);
  assert.equal((await verifiedQuantityPredecessors(f.rows, [{ id: 'current', hash: 'a'.repeat(64) }])).size, 0);
});

test('BCF restoration follows verified geometry then quantity, rejecting duplicate loaded instances', async () => {
  const { fixtureModel } = await import('@/test/store-fixture');
  const { rebindReviewRevision } = await import('./revision-lineage');
  const f = await fixture();
  const original = [{ id: 'original', name: 'original.ifcx', sourceIdentity: 'sha256:original' }];
  const context = { ...f.rows[0].context, models: original };
  const base = { ...f.rows[0], context };
  const geometryHash = (await sha256Hex(f.bytes))!;
  f.rows.push({ ...base, id: 'geometry', text: JSON.stringify({ kind: 'review.geometry.applied', modelId: 'original', topicId: 'issue', beforeHash: 'b'.repeat(64), afterHash: geometryHash }) },
    { ...base, id: 'verified', text: JSON.stringify({ kind: 'review.geometry.verified', receiptRef: 'geometry', topicId: 'issue', afterHash: geometryHash, matches: true }) });
  const parsed = await parseIfcxViewerModel(f.bytes);
  const view = new MutablePropertyView(parsed.dataStore.properties, 'session');
  view.setQuantityExtractor(id => parsed.dataStore.quantities.getForEntity(id));
  const id = parsed.dataStore.entities.getExpressIdByGlobalId('wall');
  view.setQuantity(id, 'Qto_WallBaseQuantities', 'NetVolume', 4, view.getQuantitiesForEntity(id)[0].quantities[0].type);
  const current = new Map([['current', { ...fixtureModel('current'), sourceFile: new Blob([exportSourceQuantityEdits(parsed.dataStore, view)!]) as File, sourceContentHash: 'corrected' }]]);
  assert.deepEqual(await rebindReviewRevision(original, current, f.rows), new Map([['original', 'current']]));
  // A subsequent verified geometry revision must retain the earlier quantity bridge.
  const quantityFile = current.get('current')!.sourceFile!;
  const quantityHash = (await sha256Hex(await quantityFile.arrayBuffer()))!;
  const finalFile = new Blob([await quantityFile.text(), '\n']);
  const finalHash = (await sha256Hex(await finalFile.arrayBuffer()))!;
  const intermediateContext = { ...context, models: [{ id: 'quantity-session', name: 'quantity.ifcx', sourceIdentity: 'sha256:quantity-placement' }] };
  f.rows.push({ ...base, id: 'last-geometry', context: intermediateContext, text: JSON.stringify({ kind: 'review.geometry.applied', modelId: 'quantity-session', topicId: 'mesh-issue', beforeHash: quantityHash, afterHash: finalHash }) },
    { ...base, id: 'last-verified', context: intermediateContext, text: JSON.stringify({ kind: 'review.geometry.verified', receiptRef: 'last-geometry', topicId: 'mesh-issue', afterHash: finalHash, matches: true }) });
  current.get('current')!.sourceFile = finalFile as File;
  assert.deepEqual(await rebindReviewRevision(original, current, f.rows), new Map([['original', 'current']]));
  await assert.rejects(rebindReviewRevision(original, current, f.rows.filter(row => row.id !== 'last-verified')), /no unique/);
  current.set('duplicate', { ...current.get('current')!, id: 'duplicate' });
  await assert.rejects(rebindReviewRevision(original, current, f.rows), /no unique/);
});
