/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createReviewStorage } from './storage';
import { createResolutionArchive } from './resolution-archive';
import type { ReviewFinding } from './types';
const instant = '2026-10-19T16:00:00Z';
function note(id: string, scope: string): ReviewFinding {
  return { schemaVersion: 1, id, kind: 'note', text: `Preserved ${id}`, createdAt: instant, context: { scopeId: scope,
    models: [{ id: 'model', name: 'Building', sourceIdentity: `sha256:${scope}` }], elements: [], capturedAt: instant,
    viewpoint: { guid: id, perspectiveCamera: { cameraViewPoint: { x: 1, y: 2, z: 3 }, cameraDirection: { x: 0, y: 1, z: 0 }, cameraUpVector: { x: 0, y: 0, z: 1 }, fieldOfView: 60 } } } };
}
test('all-scope bundle preserves original and corrected sources across overlapping legacy imports and roundtrip', async () => {
  const source = createReviewStorage(new IDBFactory()), api = createResolutionArchive(source);
  await source.saveFinding(note('original', 'before')); await source.saveFinding(note('corrected', 'after'));
  await source.saveEvent({ schemaVersion: 1, id: 'event', findingId: 'original', status: 'confirmed', createdAt: instant });
  const legacy = await source.exportReviewArchive('before');
  assert.deepEqual(await api.importBundle(legacy), { scopesImported: 1, findingsAdded: 0, eventsAdded: 0 });
  const bundle = await api.exportBundle(); assert.deepEqual(bundle.archives.map(a => a.scopeId), ['after', 'before']);
  const target = createReviewStorage(new IDBFactory()), restored = createResolutionArchive(target);
  await restored.importBundle(legacy);
  assert.deepEqual(await restored.importBundle(bundle), { scopesImported: 2, findingsAdded: 1, eventsAdded: 0 });
  assert.deepEqual(await restored.importBundle(bundle), { scopesImported: 2, findingsAdded: 0, eventsAdded: 0 });
  assert.deepEqual(await target.listFindings('before'), [note('original', 'before')]);
  assert.deepEqual(await target.listFindings('after'), [note('corrected', 'after')]);
  assert.equal((await target.listEvents('before'))[0].status, 'confirmed');
});
test('malformed later archive and cross-scope ID collisions fail before any live writes', async () => {
  const source = createReviewStorage(new IDBFactory()); await source.saveFinding(note('first', 'before')); await source.saveFinding(note('second', 'after'));
  const bundle = await createResolutionArchive(source).exportBundle();
  const target = createReviewStorage(new IDBFactory()), api = createResolutionArchive(target);
  const broken = structuredClone(bundle); broken.archives[1].findings[0].context.viewpoint.perspectiveCamera!.fieldOfView = 0;
  await assert.rejects(api.importBundle(broken), /camera scale/); assert.deepEqual(await target.listReviewScopes(), []);
  const collision = structuredClone(bundle); collision.archives[1].findings[0].id = collision.archives[0].findings[0].id;
  await assert.rejects(api.importBundle(collision), /Conflicting review record ID/); assert.deepEqual(await target.listReviewScopes(), []);
});
test('existing-record collisions preserve the owner data and refuse all incoming scopes', async () => {
  const source = createReviewStorage(new IDBFactory()); await source.saveFinding(note('first', 'before')); await source.saveFinding(note('second', 'after'));
  const bundle = await createResolutionArchive(source).exportBundle(), target = createReviewStorage(new IDBFactory());
  const existing = { ...note('first', 'before'), text: 'Owner amended evidence' }; await target.saveFinding(existing);
  await assert.rejects(createResolutionArchive(target).importBundle(bundle), /Conflicting review record ID/);
  assert.deepEqual(await target.listFindings('before'), [existing]); assert.deepEqual(await target.listFindings('after'), []);
});
test('bundle metadata and duplicate scopes are validated before import', async () => {
  const storage = createReviewStorage(new IDBFactory()), api = createResolutionArchive(storage);
  await assert.rejects(api.importBundle({ schemaVersion: 1, kind: 'review.resolution.bundle', exportedAt: 'invalid', archives: [] }), /Invalid resolution/);
  await storage.saveFinding(note('one', 'before')); const bundle = await api.exportBundle(); bundle.archives.push(bundle.archives[0]);
  await assert.rejects(api.importBundle(bundle), /Duplicate review scope/);
});
test('row-wise download preserves Unicode, quoted source chunks and events across a fresh storage import', async () => {
  const source = createReviewStorage(new IDBFactory());
  const original = { ...note('original', 'before'), text: '屋根 🏠 "source"\n\\ chunk' };
  await source.saveFinding(original); await source.saveFinding(note('corrected', 'after'));
  await source.saveEvent({ schemaVersion: 1, id: 'event', findingId: 'original', status: 'confirmed', createdAt: instant });
  const blob = await createResolutionArchive(source).exportBlob();
  assert.equal(blob.type, 'application/json');
  const value = JSON.parse(await blob.text());
  assert.equal(blob.size, new TextEncoder().encode(await blob.text()).length);
  const target = createReviewStorage(new IDBFactory());
  assert.deepEqual(await createResolutionArchive(target).importBundle(value), { scopesImported: 2, findingsAdded: 2, eventsAdded: 1 });
  assert.deepEqual(await target.listFindings('before'), [original]);
  assert.deepEqual(await target.listFindings('after'), [note('corrected', 'after')]);
  assert.equal((await target.listEvents('before'))[0].status, 'confirmed');
});
test('download exports scopes serially and does not return a partial backup after a storage failure', async () => {
  const source = createReviewStorage(new IDBFactory()); await source.saveFinding(note('first', 'before')); await source.saveFinding(note('second', 'after'));
  let active = 0, maximum = 0; const visited: string[] = [];
  const api = createResolutionArchive({ ...source, exportReviewArchive: async scope => {
    active++; maximum = Math.max(maximum, active); visited.push(scope);
    try { return await source.exportReviewArchive(scope); } finally { active--; }
  } });
  assert.equal(JSON.parse(await (await api.exportBlob()).text()).archives.length, 2);
  assert.equal(maximum, 1); assert.deepEqual(visited, ['after', 'before']);
  const broken = createResolutionArchive({ ...source, exportReviewArchive: async scope => {
    if (scope === 'before') throw new Error('Storage read failed');
    return source.exportReviewArchive(scope);
  } });
  await assert.rejects(broken.exportBlob(), /Storage read failed/);
  assert.equal((await source.listFindings('before')).length, 1);
});
