/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { FederatedModel } from '../../store/types';
import type { IfcxDataStore } from '../../hooks/useIfcFederation';
import { candidateContext, rebindReviewModels, reviewModels, reviewScope } from './context';
import type { ReviewContext } from './types';

function model(overrides: Partial<FederatedModel> = {}): FederatedModel {
  return { id: 'load-one', name: 'building.ifc', ifcDataStore: null, geometryResult: null,
    visible: true, collapsed: false, schemaVersion: 'IFC4', loadedAt: 1, fileSize: 1,
    idOffset: 0, maxExpressId: 100, ...overrides };
}
const loaded = (...models: FederatedModel[]) => new Map(models.map(m => [m.id, m]));
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

test('review scope is keyed by complete source bytes and remains stable across ordering, file rename and load UUID', async () => {
  const original = await reviewModels(loaded(
    model({ id: 'load-a', sourceFile: new File(['building bytes A'], 'a.ifc') }),
    model({ id: 'load-b', sourceFile: new File(['building bytes B'], 'b.ifc') }),
  ));
  assert.equal(original[0].sourceIdentity, `sha256:${digest('building bytes A')}`);
  const reloaded = await reviewModels(loaded(
    model({ id: 'reload-b', name: 'renamed B', sourceFile: new File(['building bytes B'], 'renamed-b.ifc') }),
    model({ id: 'reload-a', sourceFile: new File(['building bytes A'], 'renamed-a.ifc') }),
  ));
  assert.equal(await reviewScope(original), await reviewScope(reloaded));
  assert.deepEqual(rebindReviewModels(original, reloaded), new Map([['load-a', 'reload-a'], ['load-b', 'reload-b']]));
  const revised = await reviewModels(loaded(model({ sourceFile: new File(['building bytes C'], 'a.ifc') })));
  assert.notEqual(await reviewScope([original[0]]), await reviewScope(revised));
  assert.throws(() => rebindReviewModels([original[0]], revised), /same model revision/);
});

test('retained full content hash is reused and unknown sources remain explicitly session scoped', async () => {
  const hashes = await reviewModels(loaded(model({ sourceContentHash: digest('known bytes'), sourceFile: new File(['other'], 'other.ifc') })));
  assert.equal(hashes[0].sourceIdentity, `sha256:${digest('known bytes')}`);
  const unknown = await reviewModels(loaded(model({ id: 'ephemeral-a' })));
  const reload = await reviewModels(loaded(model({ id: 'ephemeral-b' })));
  assert.equal(unknown[0].sourceIdentity, 'session:ephemeral-a');
  assert.notEqual(await reviewScope(unknown), await reviewScope(reload));
  assert.throws(() => rebindReviewModels(unknown, reload), /same model revision/);
  await assert.rejects(reviewModels(new Map()), /Load a building model/);
});

/** This fixture exercises retained-buffer identity only, not IFC parsing. */
function ifcxModel(id: string, layer: string, overlay = 'overlay bytes'): FederatedModel {
  const store = { schemaVersion: 'IFC5',
    _federatedLayers: [{ id, name: layer, enabled: true }],
    _federatedBuffers: [
      { name: 'base.ifcx', buffer: new TextEncoder().encode('base bytes').buffer },
      { name: 'overlay.ifcx', buffer: new TextEncoder().encode(overlay).buffer },
    ],
  } as IfcxDataStore;
  return model({ id, name: 'renamable display name', schemaVersion: 'IFC5', ifcDataStore: store });
}
test('IFCX retained buffers identify the ordered stack and original layer across reload', async () => {
  const original = await reviewModels(loaded(ifcxModel('old', 'Walls')));
  const reload = await reviewModels(loaded(ifcxModel('new', 'Walls')));
  assert.match(original[0].sourceIdentity, /^ifcx-stack:[a-f0-9]{64}:layer:Walls$/);
  assert.equal(original[0].sourceIdentity, reload[0].sourceIdentity);
  assert.deepEqual(rebindReviewModels(original, reload), new Map([['old', 'new']]));
  const otherLayer = await reviewModels(loaded(ifcxModel('new', 'Openings')));
  const otherBytes = await reviewModels(loaded(ifcxModel('new', 'Walls', 'changed overlay bytes')));
  assert.notEqual(await reviewScope(original), await reviewScope(otherLayer));
  assert.notEqual(await reviewScope(original), await reviewScope(otherBytes));
});

test('restore refuses missing sources and duplicate current source instances rather than guessing by name', () => {
  const saved = [{ id: 'old', name: 'building.ifc', sourceIdentity: 'sha256:same-source' }];
  assert.throws(() => rebindReviewModels(saved, []), /same model revision/);
  assert.throws(() => rebindReviewModels(saved, [
    { ...saved[0], id: 'copy-a' }, { ...saved[0], id: 'copy-b' },
  ]), /Duplicate source instances/);
  assert.throws(() => rebindReviewModels(saved, [{ ...saved[0], id: 'new', sourceIdentity: 'sha256:other-source' }]), /same model revision/);
});

test('candidate context selects only evidenced indices and leaves uncertain identity unselected', () => {
  const context: ReviewContext = { scopeId: 'review:one', models: [{ id: 'model', name: 'building', sourceIdentity: 'sha256:one' }],
    elements: [{ modelId: 'model', expressId: 1, ifcGlobalId: 'known-guid' }, { modelId: 'model', expressId: 2, ifcGlobalId: null }],
    capturedAt: '2026-10-19T00:00:00Z', viewpoint: { guid: 'view-one', snapshot: 'data:image/png;base64,YQ==',
      components: { selection: [{ ifcGuid: 'previous-selection' }], visibility: { defaultVisibility: false, exceptions: [{ ifcGuid: 'visible-guid' }] } } } };
  const ambiguous = candidateContext(context, []);
  assert.deepEqual(ambiguous.elements, []);
  assert.deepEqual(ambiguous.viewpoint.components?.selection, []);
  assert.equal(ambiguous.viewpoint.snapshot, context.viewpoint.snapshot);
  const exact = candidateContext(context, [0, 1]);
  assert.deepEqual(exact.elements, context.elements);
  assert.deepEqual(exact.viewpoint.components?.selection, [{ ifcGuid: 'known-guid' }]);
  assert.deepEqual(exact.viewpoint.components?.visibility, context.viewpoint.components?.visibility);
  assert.deepEqual(context.viewpoint.components?.selection, [{ ifcGuid: 'previous-selection' }], 'original capture is unchanged');
});
