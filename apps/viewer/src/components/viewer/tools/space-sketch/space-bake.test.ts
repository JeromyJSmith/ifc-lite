/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { bakeStorey, bakeAllStoreys, type BakeDeps, type DraftRoom, type StoreySession } from './space-bake.js';
import type { Pt } from '@/lib/space-sketch-geometry.js';

const SQUARE_1M: DraftRoom = { outline: [[0, 0], [1, 0], [1, 1], [0, 1]], boundary: [[0, 0], [1, 0], [1, 1], [0, 1]] };
// Centred at (5, 5) — well clear of the authored footprint at the origin.
const SQUARE_AT_5: DraftRoom = { outline: [[4.5, 4.5], [5.5, 4.5], [5.5, 5.5], [4.5, 5.5]], boundary: [[4.5, 4.5], [5.5, 4.5], [5.5, 5.5], [4.5, 5.5]] };

function makeDeps(overrides: Partial<BakeDeps> = {}): { deps: BakeDeps; removed: Array<[string, number]>; added: unknown[] } {
  const removed: Array<[string, number]> = [];
  const added: unknown[] = [];
  const deps: BakeDeps = {
    removeEntity: (modelId, id) => { removed.push([modelId, id]); },
    addSpace: (modelId, storeyId, params) => {
      added.push({ modelId, storeyId, params });
      return { expressId: 100 + added.length };
    },
    ...overrides,
  };
  return { deps, removed, added };
}

describe('bakeStorey', () => {
  it('emits one IfcSpace per drafted room, keyed to the storey and height it was given', () => {
    const { deps, added } = makeDeps();
    const res = bakeStorey(7, 'model-1', [SQUARE_1M], [], 3, [], deps);
    assert.equal(res.emitted, 1);
    assert.equal(res.skipped, 0);
    assert.equal(res.error, null);
    assert.deepEqual(res.newIds, [101]);
    assert.equal(added.length, 1);
    const call = added[0] as { modelId: string; storeyId: number; params: { Height: number; OuterCurve: unknown } };
    assert.equal(call.modelId, 'model-1');
    assert.equal(call.storeyId, 7);
    assert.equal(call.params.Height, 3);
    assert.deepEqual(call.params.OuterCurve, SQUARE_1M.boundary);
  });

  it('removes every previously-generated id on the storey before emitting (replace, not accumulate)', () => {
    const { deps, removed } = makeDeps();
    bakeStorey(7, 'model-1', [SQUARE_1M], [], 3, [201, 202], deps);
    assert.deepEqual(removed, [['model-1', 201], ['model-1', 202]]);
  });

  it('skips a room whose centroid falls inside an existing AUTHORED footprint (dedup)', () => {
    const { deps, added } = makeDeps();
    const authored: Pt[][] = [[[-1, -1], [2, -1], [2, 2], [-1, 2]]]; // encloses SQUARE_1M's centroid (0.5, 0.5)
    const res = bakeStorey(7, 'model-1', [SQUARE_1M, SQUARE_AT_5], authored, 3, [], deps);
    assert.equal(res.skipped, 1);
    assert.equal(res.emitted, 1);
    assert.equal(added.length, 1); // only the un-dedup'd room reached addSpace
  });

  it('keeps the FIRST addSpace error rather than the last, and does not let it stop the remaining rooms', () => {
    let call = 0;
    const { deps, added } = makeDeps({
      addSpace: (modelId, storeyId, params) => {
        call++;
        if (call === 1) return { error: 'first failure' };
        if (call === 2) return { error: 'second failure' }; // must NOT overwrite the first
        added.push({ modelId, storeyId, params });
        return { expressId: 999 };
      },
    });
    const third: DraftRoom = { outline: [[9, 9], [10, 9], [10, 10], [9, 10]], boundary: [[9, 9], [10, 9], [10, 10], [9, 10]] };
    const res = bakeStorey(7, 'model-1', [SQUARE_1M, SQUARE_AT_5, third], [], 3, [], deps);
    assert.equal(res.error, 'first failure');
    assert.equal(res.emitted, 1, 'the third room still emits despite the first two failing');
    assert.equal(added.length, 1);
  });

  it('always replaces the generated-id list, even with zero emitted rooms (every room deduped)', () => {
    const { deps } = makeDeps();
    const authored: Pt[][] = [[[-1, -1], [2, -1], [2, 2], [-1, 2]]];
    const res = bakeStorey(7, 'model-1', [SQUARE_1M], authored, 3, [201], deps);
    assert.deepEqual(res.newIds, []);
    assert.equal(res.emitted, 0);
  });
});

describe('bakeAllStoreys', () => {
  function makeSession(alive: boolean, roomCount: number): StoreySession {
    return { alive, roomCount };
  }

  it('skips a storey whose session is dead or has zero rooms', () => {
    const { deps, added } = makeDeps();
    const sessions = new Map<number, StoreySession>([
      [1, makeSession(false, 3)],
      [2, makeSession(true, 0)],
      [3, makeSession(true, 1)],
    ]);
    const res = bakeAllStoreys(
      sessions, 'model-1', new Map(),
      () => [SQUARE_1M],
      () => 3,
      () => [],
      deps,
    );
    assert.equal(res.floors, 1, 'only storey 3 is live with rooms');
    assert.equal(added.length, 1);
  });

  it('aggregates emitted/floors across every live storey and surfaces the first error', () => {
    const { deps } = makeDeps({
      addSpace: mock.fn((_m: string, sid: number) => (sid === 1 ? { error: 'boom on 1' } : { expressId: sid })),
    });
    const sessions = new Map<number, StoreySession>([
      [1, makeSession(true, 1)],
      [2, makeSession(true, 1)],
    ]);
    const res = bakeAllStoreys(
      sessions, 'model-1', new Map(),
      () => [SQUARE_1M],
      () => 3,
      () => [],
      deps,
    );
    assert.equal(res.emitted, 1);
    assert.equal(res.floors, 1);
    assert.equal(res.error, 'boom on 1');
    assert.deepEqual(res.perStorey.get(2), [2]);
  });
});
