/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ClashSettings.timeBudgetMs`: one pair of very dense meshes must not hold a
 * run for minutes. Found on a real planting model (two 213,253-triangle
 * furniture objects, clearance 0.5 m: no result in 240 s, and an AbortSignal
 * could not stop it because the kernel only looks between pairs).
 */

import { describe, expect, it } from 'vitest';
import { createClashEngine } from '../engine.js';
import { fromPositions } from '../math/aabb.js';
import { ClashTimeBudgetExceededError, type ClashElement, type ClashRule } from '../types.js';

/** An n x n grid of quads (2 n^2 triangles) in the plane z = `z`, 1 m square. */
function sheet(key: string, tag: string, n: number, z: number): ClashElement {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let y = 0, p = 0; y <= n; y += 1) {
    for (let x = 0; x <= n; x += 1) { positions[p++] = x / n; positions[p++] = y / n; positions[p++] = z; }
  }
  const indices = new Uint32Array(n * n * 6);
  for (let y = 0, i = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
      indices[i++] = a; indices[i++] = b; indices[i++] = c; indices[i++] = b; indices[i++] = d; indices[i++] = c;
    }
  }
  return { key, ref: key === 'dense-a' ? 1 : 2, model: 'm', tag, bounds: fromPositions(positions), positions, indices };
}

const rule: ClashRule = { id: 'sheets', name: 'sheets', a: 'IfcFurniture', b: 'IfcSlab', mode: 'clearance', clearance: 5 };
const engine = () => createClashEngine({ backend: 'ts' });

describe('clash time budget', () => {
  it('stops inside one dense pair, names it, and returns no partial result', async () => {
    // 2 x 150^2 = 45,000 triangles a side, every one within the 5 m margin of every other: ~2e9 triangle pairs.
    const dense = [sheet('dense-a', 'IfcFurniture', 150, 0), sheet('dense-b', 'IfcSlab', 150, 0.25)];
    const started = performance.now();
    const failure = await engine().run(dense, [rule], { timeBudgetMs: 150 }).then(() => null, (e: unknown) => e);
    const waited = performance.now() - started;

    expect(failure).toBeInstanceOf(ClashTimeBudgetExceededError);
    const error = failure as ClashTimeBudgetExceededError;
    expect(error.budgetMs).toBe(150);
    expect(error.elapsedMs).toBeGreaterThan(150);
    expect(error.progress).toEqual({ rule: 'sheets', pair: ['dense-a', 'dense-b'], triangles: [45000, 45000] });
    expect(error.message).toContain('dense-a against dense-b (45000 x 45000 triangles)');
    // stopped by the clock inside the pair, not by the pair finishing: the full pair is orders of magnitude longer
    expect(waited).toBeLessThan(3000);
  });

  it('changes nothing about a run that fits its budget, and zero or a negative number is no budget', async () => {
    const small = () => [sheet('dense-a', 'IfcFurniture', 4, 0), sheet('dense-b', 'IfcSlab', 4, 0.25)];
    const free = await engine().run(small(), [rule]);
    expect(free.clashes).toHaveLength(1);
    expect(free.clashes[0].status).toBe('clearance');
    expect(free.clashes[0].distance).toBeCloseTo(0.25, 6);
    for (const timeBudgetMs of [60_000, 0, -1]) {
      const run = await engine().run(small(), [rule], { timeBudgetMs });
      expect(run.clashes.map((c) => [c.a.key, c.b.key, c.status, c.distance])).toEqual(free.clashes.map((c) => [c.a.key, c.b.key, c.status, c.distance]));
      expect(run.ruleCoverage).toEqual(free.ruleCoverage);
    }
  });

  it('refuses to start a rule once the budget is spent', async () => {
    const small = [sheet('dense-a', 'IfcFurniture', 4, 0), sheet('dense-b', 'IfcSlab', 4, 0.25)];
    const failure = await engine().run(small, [rule, { ...rule, id: 'second' }], { timeBudgetMs: 1e-9 }).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(ClashTimeBudgetExceededError);
    expect((failure as ClashTimeBudgetExceededError).progress.rule).toBe('sheets');
  });
});
