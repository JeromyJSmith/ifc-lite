/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureModel } from '@/test/store-fixture';
import { rebindReviewRevision, resolveRepairModel } from './revision-lineage';
import { sha256Hex } from '@/utils/sourceContentHash';
import type { ReviewFinding } from './types';
import type { FederatedModel } from '@/store/types';
async function setup() {
  const source = new Blob(['corrected geometry']);
  const hash = (await sha256Hex(await source.arrayBuffer()))!;
  const saved = [{ id: 'old-id', name: 'Original', sourceIdentity: 'sha256:original-placement-hash' }];
  const current = new Map<string, FederatedModel>([['new-id', { ...fixtureModel('new-id'), sourceFile: source as File, sourceContentHash: 'new-placement-hash' }]]);
  const context = { models: saved, elements: [], scopeId: 'original-scope', viewpoint: { guid: 'view' }, capturedAt: '2026-10-19T10:00:00Z' };
  const row = (id: string, data: unknown): ReviewFinding => ({ schemaVersion: 1, id, kind: 'note', context, createdAt: context.capturedAt, text: JSON.stringify(data) });
  const rows = [row('receipt', { kind: 'review.geometry.applied', topicId: 'issue', modelId: 'old-id', beforeHash: 'b'.repeat(64), afterHash: hash }),
    row('verification', { kind: 'review.geometry.verified', topicId: 'issue', receiptRef: 'receipt', matches: true, afterHash: hash })];
  return { saved, current, rows, hash, row };
}
test('verified exact-source repair rebinding survives model load UUID changes', async () => {
  const s = await setup(); assert.deepEqual(await rebindReviewRevision(s.saved, s.current, s.rows), new Map([['old-id', 'new-id']]));
  assert.equal(await resolveRepairModel(s.hash, s.current), 'new-id');
});
test('missing, mismatched or failed after-state evidence cannot authorize revision restore', async () => {
  const s = await setup();
  await assert.rejects(rebindReviewRevision(s.saved, s.current, [s.rows[0]]), /no unique/);
  for (const patch of [{ matches: false }, { receiptRef: 'other' }, { topicId: 'other' }, { afterHash: 'c'.repeat(64) }]) {
    const p = { ...JSON.parse(s.rows[1].text), ...patch };
    await assert.rejects(rebindReviewRevision(s.saved, s.current, [s.rows[0], s.row('verification', p)]), /no unique/);
  }
});
test('changed actual bytes and duplicate corrected source instances are rejected', async () => {
  const s = await setup();
  s.current.set('duplicate', { ...s.current.get('new-id')!, id: 'duplicate' });
  await assert.rejects(resolveRepairModel(s.hash, s.current), /exactly one/);
  await assert.rejects(rebindReviewRevision(s.saved, s.current, s.rows), /no unique/);
  s.current.delete('duplicate'); s.current.get('new-id')!.sourceFile = new Blob(['different bytes']) as File;
  await assert.rejects(rebindReviewRevision(s.saved, s.current, s.rows), /no unique/);
});
test('independent unchanged federation sources retain direct bindings', async () => {
  const s = await setup();
  s.saved.push({ id: 'unchanged-old', name: 'Other', sourceIdentity: 'sha256:other' });
  s.current.set('unchanged-new', { ...fixtureModel('unchanged-new'), sourceContentHash: 'other' });
  assert.deepEqual(await rebindReviewRevision(s.saved, s.current, s.rows), new Map([['old-id', 'new-id'], ['unchanged-old', 'unchanged-new']]));
  const wrongModelReceipt = { ...JSON.parse(s.rows[0].text), modelId: 'unchanged-old' };
  await assert.rejects(rebindReviewRevision(s.saved, s.current, [s.row('receipt', wrongModelReceipt), s.rows[1]]), /no unique/);
});

test('a subsequent repair after restart binds its explicit original federation member', async () => {
  const s = await setup();
  const receipt = { ...JSON.parse(s.rows[0].text), modelId: 'restarted-live-id', originalModelId: 'old-id' };
  assert.deepEqual(await rebindReviewRevision(s.saved, s.current, [s.row('receipt', receipt), s.rows[1]]), new Map([['old-id', 'new-id']]));
  await assert.rejects(rebindReviewRevision(s.saved, s.current, [s.row('receipt', { ...receipt, originalModelId: 'unrelated' }), s.rows[1]]), /no unique/);
});

test('verified geometry descendants remain reachable across subsequent source revisions', async () => {
  const s = await setup();
  const final = new Blob(['second corrected geometry']);
  const finalHash = (await sha256Hex(await final.arrayBuffer()))!;
  s.current.get('new-id')!.sourceFile = final as File;
  const context = { ...s.rows[0].context, models: [{ id: 'intermediate', name: 'Intermediate', sourceIdentity: 'sha256:intermediate-placement' }] };
  const applied = { ...s.row('second', { kind: 'review.geometry.applied', topicId: 'second-issue', modelId: 'intermediate', beforeHash: s.hash, afterHash: finalHash }), context };
  const verified = { ...s.row('second-check', { kind: 'review.geometry.verified', topicId: 'second-issue', receiptRef: 'second', matches: true, afterHash: finalHash }), context };
  assert.deepEqual(await rebindReviewRevision(s.saved, s.current, [...s.rows, applied, verified]), new Map([['old-id', 'new-id']]));
  await assert.rejects(rebindReviewRevision(s.saved, s.current, [...s.rows, applied]), /no unique/);
  const broken = { ...applied, text: JSON.stringify({ ...JSON.parse(applied.text), beforeHash: 'e'.repeat(64) }) };
  await assert.rejects(rebindReviewRevision(s.saved, s.current, [...s.rows, broken, verified]), /no unique/);
});
