/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildTriangleBVH } from './deviation/triangle-bvh.js';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * Coverage for the per-triangle closest-point BVH (`triangle-bvh.ts`),
 * previously untested. Every fixture below gives each axis a distinct,
 * non-zero value (per this file's own header comment: "no SAH for v1",
 * median split along the longest AABB axis) so a swapped axis or a
 * dropped term cannot hide behind a coincidentally-symmetric input.
 *
 * The strongest oracle here is `bruteForceNearest` (below): it re-derives
 * point-triangle distance from first principles (project onto the plane,
 * clamp to the triangle via barycentric coordinates, else clamp to the
 * nearest edge/vertex) and is checked against `bvhNearest`, a from-scratch
 * AABB-pruned traversal of the BVH's own node/triangle buffers. Neither
 * routine is copied from `triangle-bvh.ts` — both re-derive the geometry
 * independently, so a bug in the tree (wrong split, wrong bounds union,
 * wrong leaf range) surfaces as a mismatch between the two.
 */

function mesh(expressId: number, positions: number[], indices?: number[], origin?: [number, number, number]): MeshData {
  return {
    expressId,
    modelIndex: 0,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    indices: indices ? new Uint32Array(indices) : new Uint32Array(Array.from({ length: positions.length / 3 }, (_, i) => i)),
    color: [1, 1, 1, 1],
    origin,
  } as unknown as MeshData;
}

// ---------------------------------------------------------------------
// Independent oracle #1: closest point on a single triangle to a query
// point, hand-derived (plane projection + barycentric clamp), NOT using
// any code from triangle-bvh.ts.
// ---------------------------------------------------------------------
type Vec3 = [number, number, number];
function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function add(a: Vec3, b: Vec3, s: number): Vec3 { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }

function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  // Standard Ericson "Real-Time Collision Detection" region test.
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return add(a, ab, v);
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return add(a, ac, w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return add(b, sub(c, b), w);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return add(add(a, ab, v), ac, w);
}

function dist(p: Vec3, q: Vec3): number {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

interface Tri { v0: Vec3; v1: Vec3; v2: Vec3; }

function trianglesFromMeshes(meshes: MeshData[]): Tri[] {
  const out: Tri[] = [];
  for (const m of meshes) {
    const pos = m.positions;
    const idx = m.indices;
    const ox = m.origin ? m.origin[0] : 0;
    const oy = m.origin ? m.origin[1] : 0;
    const oz = m.origin ? m.origin[2] : 0;
    const n = idx ? idx.length : pos.length / 3;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = (idx ? idx[i] : i) * 3;
      const i1 = (idx ? idx[i + 1] : i + 1) * 3;
      const i2 = (idx ? idx[i + 2] : i + 2) * 3;
      out.push({
        v0: [pos[i0] + ox, pos[i0 + 1] + oy, pos[i0 + 2] + oz],
        v1: [pos[i1] + ox, pos[i1 + 1] + oy, pos[i1 + 2] + oz],
        v2: [pos[i2] + ox, pos[i2 + 1] + oy, pos[i2 + 2] + oz],
      });
    }
  }
  return out;
}

/** Brute-force ground truth: minimum distance from `p` to ANY triangle. */
function bruteForceNearest(p: Vec3, tris: Tri[]): number {
  let best = Infinity;
  for (const t of tris) {
    const cp = closestPointOnTriangle(p, t.v0, t.v1, t.v2);
    const d = dist(p, cp);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------
// Independent oracle #2: a from-scratch AABB-pruned traversal of the
// BVH's flat node/triangle buffers (nearest-neighbour branch-and-bound).
// This exercises the actual tree shape the builder produced: if a leaf's
// AABB is wrong, or a node's children point at the wrong range, this
// traversal either misses the true nearest triangle or returns a wrong
// bound — either way it diverges from the brute-force oracle above.
// ---------------------------------------------------------------------
const LEAF_FLAG = 0x80000000;

function sqDistToAabb(p: Vec3, mn: Vec3, mx: Vec3): number {
  let d = 0;
  for (let i = 0; i < 3; i++) {
    const v = p[i];
    if (v < mn[i]) d += (mn[i] - v) * (mn[i] - v);
    else if (v > mx[i]) d += (v - mx[i]) * (v - mx[i]);
  }
  return d;
}

function bvhNearest(p: Vec3, bvh: ReturnType<typeof buildTriangleBVH>): number {
  const nodesF = bvh.nodes;
  const nodesU = new Uint32Array(nodesF.buffer, nodesF.byteOffset, nodesF.length);
  const tris = bvh.triangles;
  let best = Infinity;
  const stack: number[] = [0];
  while (stack.length > 0) {
    const nodeIdx = stack.pop()!;
    const off = nodeIdx * 8;
    const mn: Vec3 = [nodesF[off], nodesF[off + 1], nodesF[off + 2]];
    const mx: Vec3 = [nodesF[off + 4], nodesF[off + 5], nodesF[off + 6]];
    if (sqDistToAabb(p, mn, mx) > best * best) continue; // prune
    const slot3 = nodesU[off + 3];
    const isLeaf = (slot3 & LEAF_FLAG) !== 0;
    if (isLeaf) {
      const triStart = slot3 & ~LEAF_FLAG;
      const triCount = nodesU[off + 7];
      for (let k = triStart; k < triStart + triCount; k++) {
        const toff = k * 12;
        const v0: Vec3 = [tris[toff], tris[toff + 1], tris[toff + 2]];
        const v1: Vec3 = [tris[toff + 3], tris[toff + 4], tris[toff + 5]];
        const v2: Vec3 = [tris[toff + 6], tris[toff + 7], tris[toff + 8]];
        const cp = closestPointOnTriangle(p, v0, v1, v2);
        const d = dist(p, cp);
        if (d < best) best = d;
      }
    } else {
      stack.push(slot3, nodesU[off + 7]);
    }
  }
  return best;
}

describe('buildTriangleBVH: bounds + buffer contents (hand-computed, asymmetric fixtures)', () => {
  it('single triangle: nodes/triangles/bounds match hand computation exactly', () => {
    // Every axis gets a distinct, non-zero value so a swapped axis or a
    // dropped term is observable.
    const m = mesh(1, [
      1, 2, 30,
      5, 2, 30,
      1, 9, 30,
    ]);
    const bvh = buildTriangleBVH([m]);
    assert.strictEqual(bvh.triangleCount, 1);
    assert.strictEqual(bvh.nodeCount, 1, 'single triangle stays a single leaf (default maxTrisPerLeaf=16)');
    assert.strictEqual(bvh.meshCount, 1);
    assert.deepStrictEqual(bvh.bounds, { min: [1, 2, 30], max: [5, 9, 30] });

    // Root node AABB (8 floats) must match bounds too.
    assert.strictEqual(bvh.nodes[0], 1);
    assert.strictEqual(bvh.nodes[1], 2);
    assert.strictEqual(bvh.nodes[2], 30);
    assert.strictEqual(bvh.nodes[4], 5);
    assert.strictEqual(bvh.nodes[5], 9);
    assert.strictEqual(bvh.nodes[6], 30);

    // Triangle buffer: verts as authored, then a unit normal.
    assert.deepStrictEqual(Array.from(bvh.triangles.subarray(0, 9)), [1, 2, 30, 5, 2, 30, 1, 9, 30]);
    const nx = bvh.triangles[9], ny = bvh.triangles[10], nz = bvh.triangles[11];
    // v1-v0 = (4,0,0), v2-v0 = (0,7,0) -> cross = (0,0,28) -> normalised (0,0,1).
    assert.ok(Math.abs(nx - 0) < 1e-6 && Math.abs(ny - 0) < 1e-6 && Math.abs(nz - 1) < 1e-6, `expected normal (0,0,1), got (${nx},${ny},${nz})`);
  });

  it('bounds union across meshes: Y and Z are NOT swapped (asymmetric extents catch a transposed axis)', () => {
    // Distinct, non-overlapping extents per axis across two meshes so a
    // Y/Z (or X/Y) swap in the bounds union changes the numeric result,
    // not just which axis label it's under.
    const m1 = mesh(1, [
      -10, 100, 1000,
      -9, 101, 1001,
      -9.5, 100.5, 1000.5,
    ]);
    const m2 = mesh(2, [
      50, -200, 2000,
      51, -199, 2001,
      50.5, -199.5, 2000.5,
    ]);
    const bvh = buildTriangleBVH([m1, m2]);
    // Hand-computed per axis independently.
    assert.strictEqual(bvh.bounds.min[0], -10);
    assert.strictEqual(bvh.bounds.max[0], 51);
    assert.strictEqual(bvh.bounds.min[1], -200);
    assert.strictEqual(bvh.bounds.max[1], 101);
    assert.strictEqual(bvh.bounds.min[2], 1000);
    assert.strictEqual(bvh.bounds.max[2], 2001);
  });

  it('mesh.origin is folded into triangle positions, centroids, and bounds', () => {
    const m = mesh(1, [0, 0, 0, 1, 0, 0, 0, 1, 0], undefined, [100, 200, 300]);
    const bvh = buildTriangleBVH([m]);
    assert.deepStrictEqual(Array.from(bvh.triangles.subarray(0, 9)), [100, 200, 300, 101, 200, 300, 100, 201, 300]);
    assert.deepStrictEqual(bvh.bounds, { min: [100, 200, 300], max: [101, 201, 300] });
  });

  it('indexed vs non-indexed positions produce the same triangle buffer', () => {
    const positions = [1, 2, 3, 4, 5, 6, 7, 8, 10];
    const indexed = mesh(1, positions, [0, 1, 2]);
    const nonIndexed = mesh(2, positions); // helper defaults indices to [0,1,2,...]
    const bvhA = buildTriangleBVH([indexed]);
    const bvhB = buildTriangleBVH([nonIndexed]);
    assert.deepStrictEqual(Array.from(bvhA.triangles), Array.from(bvhB.triangles));
  });

  it('empty mesh set: single zero-bound leaf, no crash', () => {
    const bvh = buildTriangleBVH([]);
    assert.strictEqual(bvh.triangleCount, 0);
    assert.strictEqual(bvh.nodeCount, 1);
    assert.deepStrictEqual(bvh.bounds, { min: [0, 0, 0], max: [0, 0, 0] });
    const nodesU = new Uint32Array(bvh.nodes.buffer, bvh.nodes.byteOffset, bvh.nodes.length);
    assert.strictEqual((nodesU[3] & LEAF_FLAG) >>> 0, LEAF_FLAG, 'the sentinel node must be a leaf');
    assert.strictEqual(nodesU[7], 0, 'the sentinel leaf has 0 triangles');
  });

  it('meshes with zero-length positions are skipped by the triangle count but still counted in meshCount', () => {
    // Documents observed (non-obvious) behaviour: `meshCount` is
    // `meshes.length` verbatim -- it does NOT subtract meshes that
    // contributed zero triangles. `triangleCount`, by contrast, only
    // counts meshes with actual geometry. A caller using `meshCount` as
    // "how many meshes have triangles in this BVH" would be wrong.
    const real = mesh(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const emptyPositions: MeshData = {
      ...real,
      expressId: 2,
      positions: new Float32Array(0),
    } as unknown as MeshData;
    const bvh = buildTriangleBVH([real, emptyPositions]);
    assert.strictEqual(bvh.triangleCount, 1, 'only the mesh with positions contributes a triangle');
    assert.strictEqual(bvh.meshCount, 2, 'meshCount counts every input mesh, including the empty one');
  });
});

describe('buildTriangleBVH: degenerate triangle handling (no NaN escapes)', () => {
  it('a zero-area triangle gets the default normal (0,1,0), not NaN', () => {
    // All three vertices collinear (in fact identical in Y/Z) -> zero-area.
    const m = mesh(1, [
      3, 4, 5,
      3, 4, 5,
      3, 4, 5,
    ]);
    const bvh = buildTriangleBVH([m]);
    const nx = bvh.triangles[9], ny = bvh.triangles[10], nz = bvh.triangles[11];
    assert.strictEqual(nx, 0);
    assert.strictEqual(ny, 1);
    assert.strictEqual(nz, 0);
    for (let i = 0; i < bvh.triangles.length; i++) {
      assert.ok(!Number.isNaN(bvh.triangles[i]), `triangle buffer must contain no NaN at index ${i}`);
    }
    for (let i = 0; i < bvh.nodes.length; i++) {
      assert.ok(!Number.isNaN(bvh.nodes[i]), `node buffer must contain no NaN at index ${i}`);
    }
  });

  it('a degenerate triangle mixed with real triangles does not poison the shared BVH bounds', () => {
    const degenerate = mesh(1, [7, 7, 7, 7, 7, 7, 7, 7, 7]);
    const real = mesh(2, [-3, -20, 40, 9, -20, 40, -3, 15, 40]);
    const bvh = buildTriangleBVH([degenerate, real]);
    for (let i = 0; i < bvh.bounds.min.length; i++) {
      assert.ok(!Number.isNaN(bvh.bounds.min[i]) && !Number.isNaN(bvh.bounds.max[i]));
    }
    // Degenerate triangle's single point (7,7,7) must be inside the union.
    assert.ok(bvh.bounds.min[0] <= 7 && bvh.bounds.max[0] >= 7);
    assert.ok(bvh.bounds.min[1] <= 7 && bvh.bounds.max[1] >= 7);
    assert.ok(bvh.bounds.min[2] <= 7 && bvh.bounds.max[2] >= 7);
  });
});

describe('buildTriangleBVH: tree structure (leaf split, one arm of N)', () => {
  it('a triangle count under the threshold stays a single leaf (one arm: leaf)', () => {
    const meshes: MeshData[] = [];
    for (let i = 0; i < 5; i++) {
      meshes.push(mesh(i, [i, i * 2, i * 3, i + 1, i * 2, i * 3, i, i * 2 + 1, i * 3]));
    }
    const bvh = buildTriangleBVH(meshes, { maxTrisPerLeaf: 16 });
    assert.strictEqual(bvh.nodeCount, 1, 'below-threshold triangle count must not split');
  });

  it('a triangle count over the threshold splits into an internal root + leaves (one arm: interior)', () => {
    // 40 triangles spread widely along X only vs. a small maxTrisPerLeaf
    // forces at least one split; every triangle still gets distinct,
    // non-zero Y/Z so the split logic can't accidentally degenerate.
    const meshes: MeshData[] = [];
    for (let i = 0; i < 40; i++) {
      const x = i * 10;
      meshes.push(mesh(i, [x, 3, 5, x + 1, 3, 5, x, 4, 6]));
    }
    const bvh = buildTriangleBVH(meshes, { maxTrisPerLeaf: 4 });
    assert.strictEqual(bvh.triangleCount, 40);
    assert.ok(bvh.nodeCount > 1, 'over-threshold triangle count must produce an interior split, got nodeCount=' + bvh.nodeCount);

    // Structural invariant: every leaf's [triStart, triStart+triCount)
    // range, unioned across all leaves reached by traversal from the
    // root, must be a partition (no gaps, no overlaps) of [0, triangleCount).
    const nodesU = new Uint32Array(bvh.nodes.buffer, bvh.nodes.byteOffset, bvh.nodes.length);
    const covered: boolean[] = new Array(bvh.triangleCount).fill(false);
    const stack = [0];
    let leafCount = 0;
    while (stack.length > 0) {
      const nodeIdx = stack.pop()!;
      const off = nodeIdx * 8;
      const slot3 = nodesU[off + 3];
      const isLeaf = (slot3 & LEAF_FLAG) !== 0;
      if (isLeaf) {
        leafCount++;
        const start = slot3 & ~LEAF_FLAG;
        const count = nodesU[off + 7];
        for (let k = start; k < start + count; k++) {
          assert.strictEqual(covered[k], false, `triangle ${k} covered by more than one leaf`);
          covered[k] = true;
        }
      } else {
        stack.push(slot3, nodesU[off + 7]);
      }
    }
    assert.ok(leafCount >= 2, 'expected multiple leaves for an over-threshold build');
    assert.ok(covered.every(Boolean), 'every triangle must be covered by exactly one leaf');
  });

  it('splits along the longest centroid-spread axis, not always X (one arm: Y-dominant split)', () => {
    // Centroid spread is far larger along Y than X or Z. If the axis
    // selection defaulted to X (or ignored spread), the two children's
    // Y-centroid ranges would overlap heavily; with a correct Y-split
    // they must not.
    const meshes: MeshData[] = [];
    // X order is deliberately UNCORRELATED with Y order (x cycles
    // 0..7 in a different permutation than increasing i), so a build
    // that splits on X instead of the (correct, widest) Y axis
    // produces a visibly different, non-monotonic partition -- this
    // fixture does not let a wrong-axis split coincidentally reproduce
    // the right-axis partition via insertion order.
    const xPerm = [5, 1, 6, 0, 7, 2, 4, 3];
    for (let i = 0; i < 8; i++) {
      const y = i * 1000; // huge Y spread
      const x = xPerm[i] * 0.001; // tiny X spread, shuffled relative to Y order
      meshes.push(mesh(i, [x, y, 2, x + 0.0001, y, 2, x, y + 0.1, 2]));
    }
    const bvh = buildTriangleBVH(meshes, { maxTrisPerLeaf: 1 });
    const nodesU = new Uint32Array(bvh.nodes.buffer, bvh.nodes.byteOffset, bvh.nodes.length);
    // Root (node 0) must be internal given maxTrisPerLeaf=1 and 8 triangles.
    const rootSlot3 = nodesU[3];
    assert.strictEqual(rootSlot3 & LEAF_FLAG, 0, 'root must be internal');
    const leftIdx = rootSlot3;
    const rightIdx = nodesU[7];
    const leftOff = leftIdx * 8, rightOff = rightIdx * 8;
    // Left child's Y-max must be <= right child's Y-min (median split on Y).
    const leftYMax = bvh.nodes[leftOff + 5];
    const rightYMin = bvh.nodes[rightOff + 1];
    assert.ok(leftYMax <= rightYMin, `expected a clean Y median split, got leftYMax=${leftYMax} rightYMin=${rightYMin}`);
  });
});

describe('buildTriangleBVH: nearest-triangle query cross-check (brute force vs. BVH traversal)', () => {
  it('BVH nearest-distance traversal agrees with brute force across many meshes and query points', () => {
    const meshes: MeshData[] = [];
    // Scattered, asymmetric triangles across a wide, non-cubic volume.
    for (let i = 0; i < 60; i++) {
      const x = (i * 37) % 500 - 250;
      const y = (i * 91) % 130 - 40;
      const z = (i * 13) % 900 - 100;
      meshes.push(mesh(i, [
        x, y, z,
        x + 3 + (i % 5), y + 1, z + 2,
        x + 1, y + 4 + (i % 7), z + 5,
      ]));
    }
    const bvh = buildTriangleBVH(meshes, { maxTrisPerLeaf: 4 });
    const tris = trianglesFromMeshes(meshes);
    assert.strictEqual(tris.length, bvh.triangleCount);

    const queryPoints: Vec3[] = [
      [0, 0, 0],
      [-300, -60, -150],
      [400, 90, 850],
      [10, 5, 20],
      [-250, -40, -100], // exactly at a fixture corner
      [123, -17, 456],
      [1000, 1000, 1000], // far outside the whole set
      [-1000, 500, -1000],
    ];
    for (const p of queryPoints) {
      const expected = bruteForceNearest(p, tris);
      const actual = bvhNearest(p, bvh);
      assert.ok(
        Math.abs(expected - actual) < 1e-4,
        `mismatch at point ${JSON.stringify(p)}: brute-force=${expected}, bvh-traversal=${actual}`,
      );
    }
  });

  it('a query point immediately adjacent to a leaf boundary still finds the true nearest triangle', () => {
    // Two meshes, deliberately split by the builder (maxTrisPerLeaf=1),
    // with the query point closer to the SECOND mesh even though the
    // first is checked first by a naive linear scan -- makes sure BVH
    // pruning doesn't short-circuit on the first leaf it visits.
    const far = mesh(1, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const near = mesh(2, [500, 700, -300, 501, 700, -300, 500, 701, -300]);
    const bvh = buildTriangleBVH([far, near], { maxTrisPerLeaf: 1 });
    const tris = trianglesFromMeshes([far, near]);
    const p: Vec3 = [499, 699.5, -300];
    const expected = bruteForceNearest(p, tris);
    const actual = bvhNearest(p, bvh);
    assert.ok(Math.abs(expected - actual) < 1e-4, `expected ${expected}, got ${actual}`);
    // Sanity: the near mesh really is much closer than the far one, so
    // this test is actually exercising the "prefer near leaf" pruning.
    assert.ok(expected < 5, `sanity: query point should be near the 'near' mesh, got distance ${expected}`);
  });
});
