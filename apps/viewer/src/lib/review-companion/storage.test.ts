/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createReviewStorage, REVIEW_DATABASE_NAME } from './storage';
import type { ReviewFinding, ReviewEvent } from './types';

const instant = '2026-10-19T16:00:00.000Z';
function note(id = 'note-one', scopeId = 'model-sha256:abc'): ReviewFinding {
  return {
    schemaVersion: 1, id, kind: 'note', text: 'Check the window sill against a measured height.', createdAt: instant,
    context: {
      scopeId, models: [{ id: 'building-a', name: 'building.ifc', sourceIdentity: 'sha256:abc' }],
      elements: [{ modelId: 'building-a', expressId: 42, ifcGlobalId: '0abcdefghijklmnopqrstu' }],
      capturedAt: instant,
      viewpoint: {
        guid: 'camera-one',
        perspectiveCamera: { cameraViewPoint: { x: 12, y: 4, z: 3 }, cameraDirection: { x: 0, y: 0, z: -1 }, cameraUpVector: { x: 0, y: 1, z: 0 }, fieldOfView: 60 },
        snapshot: 'data:image/png;base64,iVBORw0KGgo=',
        clippingPlanes: [{ location: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: -1, z: 0 } }],
        components: { selection: [{ ifcGuid: '0abcdefghijklmnopqrstu' }] },
      },
    },
  };
}
function status(id = 'status-one', findingId = 'note-one'): ReviewEvent {
  return { schemaVersion: 1, id, findingId, status: 'confirmed', createdAt: instant };
}

test('reopen retains exact model, selection, viewpoint, screenshot and status provenance across scopes', async () => {
  const factory = new IDBFactory();
  const first = createReviewStorage(factory);
  const finding = note();
  finding.provider = { model: 'vision-model', endpoint: 'http://localhost:8080/v1/chat/completions' };
  await first.saveFinding(finding);
  await first.saveFinding(note('other', 'different-source-sha256'));
  await first.saveEvent(status());
  const reopened = createReviewStorage(factory);
  assert.deepEqual(await reopened.listFindings(finding.context.scopeId), [finding]);
  assert.deepEqual(await reopened.listEvents(finding.context.scopeId), [status()]);
  assert.deepEqual(await reopened.listEvents('different-source-sha256'), []);
  assert.equal((await reopened.listFindings('different-source-sha256'))[0].id, 'other');
  assert.deepEqual(await reopened.listFindings('absent-scope'), []);
  assert.deepEqual(await reopened.listReviewScopes(), [
    { scopeId: 'different-source-sha256', models: note().context.models, count: 1 },
    { scopeId: finding.context.scopeId, models: finding.context.models, count: 1 },
  ]);
});

test('same ID with reordered object keys is idempotent; changed text cannot overwrite the original', async () => {
  const store = createReviewStorage(new IDBFactory());
  const original = note();
  await store.saveFinding(original);
  const { context, ...rest } = original;
  await store.saveFinding({ context, ...rest });
  await assert.rejects(store.saveFinding({ ...original, text: 'Changed assertion' }), /Conflicting review record ID/);
  assert.deepEqual(await store.listFindings(original.context.scopeId), [original]);
  await store.saveEvent(status());
  await store.saveEvent(status());
  await assert.rejects(store.saveEvent({ ...status(), status: 'dismissed' }), /Conflicting review record ID/);
  assert.deepEqual(await store.listEvents(original.context.scopeId), [status()]);
});

test('JSON export/import roundtrip preserves evidence and repeated import adds nothing', async () => {
  const source = createReviewStorage(new IDBFactory());
  await source.saveFinding(note());
  const candidate = { ...note('candidate-two'), kind: 'candidate' as const, parentId: 'note-one', text: 'Possible disconnected sill; inspection required.' };
  await source.saveFinding(candidate);
  await source.saveEvent(status());
  const archive = await source.exportReviewArchive(note().context.scopeId);
  assert.equal(archive.scopeId, note().context.scopeId);
  assert.ok(Number.isFinite(Date.parse(archive.exportedAt)));
  const destination = createReviewStorage(new IDBFactory());
  assert.deepEqual(await destination.importReviewArchive(JSON.parse(JSON.stringify(archive))), { findingsAdded: 2, eventsAdded: 1 });
  assert.deepEqual(await destination.importReviewArchive(archive), { findingsAdded: 0, eventsAdded: 0 });
  const exported = await destination.exportReviewArchive(archive.scopeId);
  assert.deepEqual(exported.findings, archive.findings);
  assert.deepEqual(exported.events, archive.events);
  assert.equal(exported.findings.find(f => f.id === 'candidate-two')?.parentId, 'note-one');
});

test('a conflicting imported finding aborts all additions in the transaction', async () => {
  const store = createReviewStorage(new IDBFactory());
  await store.saveFinding(note());
  const archive = { schemaVersion: 1, scopeId: note().context.scopeId, exportedAt: instant,
    findings: [note('new-before-conflict'), { ...note(), text: 'Conflicting evidence' }], events: [status('new-event', 'new-before-conflict')] };
  await assert.rejects(store.importReviewArchive(archive), /Conflicting review record ID/);
  assert.deepEqual(await store.listFindings(note().context.scopeId), [note()]);
  assert.deepEqual(await store.listEvents(note().context.scopeId), []);
});

test('a conflicting imported event also rolls back newly added findings', async () => {
  const store = createReviewStorage(new IDBFactory());
  await store.saveFinding(note());
  await store.saveEvent(status());
  await assert.rejects(store.importReviewArchive({ schemaVersion: 1, scopeId: note().context.scopeId, exportedAt: instant,
    findings: [note(), note('new-one')], events: [{ ...status(), status: 'resolved' }] }), /Conflicting review record ID/);
  assert.deepEqual(await store.listFindings(note().context.scopeId), [note()]);
  assert.deepEqual(await store.listEvents(note().context.scopeId), [status()]);
});

test('orphan events and cross-scope parent links are refused', async () => {
  const store = createReviewStorage(new IDBFactory());
  await assert.rejects(store.saveEvent(status()), /finding does not exist/);
  await store.saveFinding(note());
  await assert.rejects(store.saveFinding({ ...note('child', 'other-scope'), parentId: 'note-one' }), /another review scope/);
  assert.deepEqual(await store.listFindings('other-scope'), []);
});

test('untrusted imports reject invalid camera, executable snapshots, prototype keys, mixed scope and dangling events', async () => {
  const store = createReviewStorage(new IDBFactory());
  const archive = { schemaVersion: 1, scopeId: note().context.scopeId, exportedAt: instant, findings: [note()], events: [] };
  const badSnapshot = structuredClone(archive);
  badSnapshot.findings[0].context.viewpoint.snapshot = 'data:image/svg+xml;base64,PHN2Zz4=';
  await assert.rejects(store.importReviewArchive(badSnapshot), /Snapshot/);
  const badCamera = structuredClone(archive);
  badCamera.findings[0].context.viewpoint.perspectiveCamera!.cameraViewPoint.x = Infinity;
  await assert.rejects(store.importReviewArchive(badCamera), /viewpoint vector/);
  const unbound = structuredClone(archive);
  unbound.findings[0].context.elements[0].modelId = 'missing-model';
  await assert.rejects(store.importReviewArchive(unbound), /Unbound/);
  await assert.rejects(store.importReviewArchive({ ...archive, scopeId: 'wrong' }), /Mixed review scope/);
  await assert.rejects(store.importReviewArchive({ ...archive, events: [status('orphan', 'absent')] }), /Orphan event/);
  await assert.rejects(store.importReviewArchive(JSON.parse(JSON.stringify(archive).replace('"kind":"note"', '"__proto__":{"polluted":true},"kind":"note"'))), /Unsafe review key/);
  assert.deepEqual(await store.listFindings(archive.scopeId), []);
});

test('an externally aborted transaction rejects save rather than reporting success', async () => {
  const factory = new IDBFactory();
  const open = factory.open.bind(factory);
  factory.open = (...args: Parameters<IDBFactory['open']>) => {
    const request = open(...args);
    request.addEventListener('success', () => {
      const db = request.result;
      const transact = db.transaction.bind(db);
      db.transaction = (...txArgs: Parameters<IDBDatabase['transaction']>) => {
        const tx = transact(...txArgs);
        queueMicrotask(() => tx.abort());
        return tx;
      };
    });
    return request;
  };
  await assert.rejects(createReviewStorage(factory).saveFinding(note()), /aborted/);
  factory.open = open;
  assert.deepEqual(await createReviewStorage(factory).listFindings(note().context.scopeId), []);
});

test('newer database versions produce an actionable failure without deleting existing data', async () => {
  const factory = new IDBFactory();
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(REVIEW_DATABASE_NAME, 2);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  await assert.rejects(createReviewStorage(factory).saveFinding(note()), { name: 'VersionError' });
});

test('normalized visual location survives backup roundtrip and invalid coordinates cannot enter storage', async () => {
  const source = createReviewStorage(new IDBFactory());
  const located = { ...note(), location: { x: 0.25, y: 0.75 } };
  await source.saveFinding(located);
  const archive = await source.exportReviewArchive(located.context.scopeId);
  const target = createReviewStorage(new IDBFactory());
  await target.importReviewArchive(JSON.parse(JSON.stringify(archive)));
  assert.deepEqual((await target.listFindings(located.context.scopeId))[0].location, located.location);
  await assert.rejects(target.saveFinding({ ...note('invalid-point'), location: { x: -1, y: 0.5 } }), /normalized screenshot location/);
  assert.equal((await target.listFindings(located.context.scopeId)).length, 1);
});

test('exact-ID reads survive reopen, deduplicate requests and leave all unrelated evidence intact', async () => {
  const factory = new IDBFactory(), store = createReviewStorage(factory);
  await store.saveFinding(note('one')); await store.saveFinding(note('other', 'other-scope'));
  const reopened = createReviewStorage(factory);
  assert.deepEqual(await reopened.getFindingsByIds(['one', 'missing', 'one']), [note('one')]);
  assert.deepEqual(await reopened.getFindingsByIds([]), []);
  assert.equal((await reopened.listAllFindings()).length, 2);
  await assert.rejects(reopened.getFindingsByIds(['']), /identifier/);
  await assert.rejects(reopened.getFindingsByIds(Array(10001).fill('one')), /Too many/);
});
