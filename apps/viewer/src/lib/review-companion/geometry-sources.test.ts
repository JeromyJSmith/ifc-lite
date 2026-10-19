/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createReviewStorage } from './storage';
import { readGeometrySource, saveGeometrySource, loadGeometrySourceRecords } from './geometry-sources';
import type { ReviewFinding } from './types';
function base(): ReviewFinding {
  return { schemaVersion: 1, id: 'issue', kind: 'candidate', text: 'Possible mesh defect', createdAt: new Date().toISOString(), context: {
    scopeId: 'scope', capturedAt: new Date().toISOString(), models: [], elements: [],
    viewpoint: { guid: 'view', snapshot: 'data:image/png;base64,aA==', perspectiveCamera: { cameraViewPoint: { x: 1, y: 2, z: 3 }, cameraDirection: { x: 0, y: 1, z: 0 }, cameraUpVector: { x: 0, y: 0, z: 1 }, fieldOfView: 60 } },
  } };
}
function source(text = 'Some IFCX source') { return new TextEncoder().encode(JSON.stringify({ data: [], description: text })).buffer; }
test('source round trips exact UTF8 across quote-heavy and astral Unicode chunks', async () => {
  const rows: ReviewFinding[] = [base()];
  const buffer = source('"\\🪴é'.repeat(18000));
  const saved = await saveGeometrySource(buffer, rows[0], async row => { rows.push(structuredClone(row)); return row.id; });
  assert.ok(saved.chunkCount > 1);
  assert.equal(saved.byteLength, buffer.byteLength);
  assert.deepEqual(new Uint8Array(await readGeometrySource(saved.manifestRef, rows)), new Uint8Array(buffer));
  for (const row of rows.slice(1)) { assert.ok(row.text.length < 50000); assert.equal(row.context.viewpoint.snapshot, undefined); }
  assert.equal(rows.at(-1)?.parentId, 'issue');
});
test('restart/backup read uses only serialized saved rows; corruption and absent chunks refuse', async () => {
  const rows: ReviewFinding[] = [base()];
  const saved = await saveGeometrySource(source(), rows[0], async row => { rows.push(row); return row.id; });
  const restarted: ReviewFinding[] = JSON.parse(JSON.stringify(rows));
  assert.deepEqual(new Uint8Array(await readGeometrySource(saved.manifestRef, restarted)), new Uint8Array(source()));
  const corrupt = structuredClone(restarted);
  const chunk = JSON.parse(corrupt[1].text); chunk.text += 'changed'; corrupt[1].text = JSON.stringify(chunk);
  await assert.rejects(readGeometrySource(saved.manifestRef, corrupt), /integrity/);
  await assert.rejects(readGeometrySource(saved.manifestRef, restarted.filter(row => row.id !== restarted[1].id)), /missing/);
  restarted[1].context.scopeId = 'another';
  await assert.rejects(readGeometrySource(saved.manifestRef, restarted), /scope/);
});
test('partial persistence never returns a committed source manifest', async () => {
  const rows: ReviewFinding[] = [base()];
  await assert.rejects(saveGeometrySource(source('x'.repeat(100000)), rows[0], async row => {
    if (rows.length > 1) throw new Error('disk full'); rows.push(row); return row.id;
  }), /disk full/);
  assert.equal(rows.some(row => row.text.startsWith('{"kind":"review.geometry.source",')), false);
});

test('existing IndexedDB archive export/import preserves geometry source and undo bytes', async () => {
  const storage = createReviewStorage(new IDBFactory()), issue = base();
  await storage.saveFinding(issue);
  const original = source('original 🪴'.repeat(9000));
  const corrected = source('corrected geometry'.repeat(9000));
  const persist = async (row: ReviewFinding) => { await storage.saveFinding(row); return row.id; };
  const first = await saveGeometrySource(original, issue, persist);
  const second = await saveGeometrySource(corrected, issue, persist);
  const archive = await storage.exportReviewArchive(issue.context.scopeId);
  const destination = createReviewStorage(new IDBFactory());
  await destination.importReviewArchive(JSON.parse(JSON.stringify(archive)));
  const rows = await destination.listFindings(issue.context.scopeId);
  assert.deepEqual(new Uint8Array(await readGeometrySource(first.manifestRef, rows)), new Uint8Array(original));
  assert.deepEqual(new Uint8Array(await readGeometrySource(second.manifestRef, rows)), new Uint8Array(corrected));
});

test('targeted source read fetches only the manifest and committed chunk IDs', async () => {
  const rows: ReviewFinding[] = [base()];
  const saved = await saveGeometrySource(source(), rows[0], async row => { rows.push(row); return row.id; });
  const requests: string[][] = [];
  const selected = await loadGeometrySourceRecords(saved.manifestRef, async ids => { requests.push(ids); return rows.filter(row => ids.includes(row.id)); });
  assert.deepEqual(requests[0], [saved.manifestRef]);
  assert.ok(!selected.some(row => row.id === rows[0].id));
  assert.deepEqual(new Uint8Array(await readGeometrySource(saved.manifestRef, selected)), new Uint8Array(source()));
  await assert.rejects(loadGeometrySourceRecords('missing', async () => []), /manifest is missing/);
});
