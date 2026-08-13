/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Duplicate-scan grouping survives the store's exclusion pipeline.
 *
 * Two features landed on separate branches and both touch how `clashGroups`
 * gets computed from a run:
 *
 * - user-defined exclusions (#2535) made `setClashResult` re-derive
 *   `clashResult` + `clashGroups` from the RAW run on every exclusion CRUD, so
 *   toggling a rule never needs a re-run;
 * - the duplicate scan (#2530) groups its result into COINCIDENT SETS
 *   (`groupDuplicateSets` — connected components of the pair graph, no
 *   epsilon), a different algorithm from the spatial CLUSTER grouping every
 *   other run uses.
 *
 * Naively resolving that overlap by keeping #2535's `setClashResult` and
 * dropping the (now nonexistent) `setClashGroups` call the duplicate scan used
 * to make hardcodes cluster grouping for every result, duplicates included —
 * and does so silently: nothing throws, every OTHER exclusions test still
 * passes, because they never run a duplicates-shaped result through the store.
 * These tests pin the duplicate-scan case specifically, including the mid-run
 * exclusion toggle that would otherwise clobber the coincident-set grouping
 * with cluster grouping the moment the user touches an exclusion rule.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { DUPLICATES_RULE, type Clash, type ClashElementRef, type ClashResult } from '@ifc-lite/clash';
import { createClashSlice, type ClashSlice } from './clashSlice.js';
import { elementPairExclusion } from '@/lib/clash/exclusions';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  get length(): number { return this.store.size; }
  key(i: number): string | null { return [...this.store.keys()][i] ?? null; }
}

const g = globalThis as { localStorage?: unknown };

function ref(key: string, tag: string, name: string): ClashElementRef {
  return { model: 'm1', key, tag, ref: 0, name };
}

let seq = 0;
function dupClash(a: ClashElementRef, b: ClashElementRef): Clash {
  seq += 1;
  return {
    id: `d${seq}`,
    a,
    b,
    rule: DUPLICATES_RULE.id,
    status: 'hard',
    distance: 0,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'major',
  };
}

// Three elements of THREE DIFFERENT IFC classes, chained X–Y–Z: X and Z never
// clash directly, only through Y. This is the discriminator between the two
// grouping algorithms:
//   - groupDuplicateSets partitions by RULE ONLY, then takes connected
//     components of the pair graph: X–Y and Y–Z share node Y, so all three
//     land in ONE set (whatever their IFC classes).
//   - groupClashes({ by: 'cluster' }) partitions by (rule, TYPE PAIR) first —
//     "IfcBeam|IfcColumn" and "IfcColumn|IfcSlab" are different buckets no
//     matter how close the elements sit — so it produces TWO separate
//     single-member groups instead.
// A result grouped the wrong way is therefore visible as `groups.length`
// (1 vs 2) without depending on any distance/epsilon value.
const elX = ref('GUID_X', 'IfcBeam', 'X');
const elY = ref('GUID_Y', 'IfcColumn', 'Y');
const elZ = ref('GUID_Z', 'IfcSlab', 'Z');

function chainResult(): ClashResult {
  const clashes = [dupClash(elX, elY), dupClash(elY, elZ)];
  return {
    clashes,
    summary: {
      total: 2,
      byRule: { [DUPLICATES_RULE.id]: 2 },
      byTypePair: { 'IfcBeam vs IfcColumn': 1, 'IfcColumn vs IfcSlab': 1 },
      bySeverity: { critical: 0, major: 2, minor: 0, info: 0 },
    },
    rulesRun: [DUPLICATES_RULE],
    settings: { tolerance: 0, excludeVoidsAndHosts: true },
  };
}

/** Build a live slice whose actions see their own committed state (matches
 *  the pattern in clashSlice.exclusions.test.ts). */
function slice(): { get: () => ClashSlice } {
  let state: ClashSlice;
  const set = (partial: unknown) => {
    const patch = typeof partial === 'function'
      ? (partial as (s: ClashSlice) => Partial<ClashSlice>)(state)
      : (partial as Partial<ClashSlice>);
    state = { ...state, ...patch };
  };
  state = createClashSlice(set as never, (() => state) as never, {} as never);
  return { get: () => state };
}

describe('duplicate-scan grouping survives the exclusion-derivation pipeline', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
  });

  it('a duplicates run groups by coincident SET, not spatial cluster', () => {
    const s = slice();
    s.get().setClashResult(chainResult(), 'duplicates');
    const groups = s.get().clashGroups ?? [];
    // Cluster grouping (the naive-resolution behavior) would split this into
    // TWO groups — one per distinct type pair. Coincident-set grouping keeps
    // it ONE: X, Y and Z are one connected component.
    assert.strictEqual(groups.length, 1, 'X–Y–Z must group as one coincident set, not split by type pair');
    assert.strictEqual(groups[0]?.members.length, 2);
    assert.match(groups[0]?.title ?? '', /coincident/, 'title must name the set as coincident');
  });

  it('a normal (non-duplicates) run keeps spatial cluster grouping', () => {
    const s = slice();
    // Same shape of result, but reported as an ordinary detection run: must
    // NOT be treated as coincident sets.
    s.get().setClashResult(chainResult());
    const groups = s.get().clashGroups ?? [];
    assert.strictEqual(groups.length, 2, 'a non-duplicates run must partition by type pair, not connectivity');
  });

  it('toggling an exclusion mid-duplicates-run keeps coincident-set grouping (does not fall back to cluster)', () => {
    // The subtler failure: even a fix that grouped a duplicates run correctly
    // ONCE can still clobber it the moment the user touches an exclusion,
    // if the re-derivation triggered by that CRUD forgets which algorithm
    // produced the run it is re-deriving from.
    const s = slice();
    s.get().setClashResult(chainResult(), 'duplicates');
    assert.strictEqual(s.get().clashGroups?.length, 1, 'sanity: starts as one coincident set');

    // Exclude X–Y only; Y–Z survives as the sole remaining clash.
    const result = s.get().addClashExclusion(elementPairExclusion(elX, elY));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(s.get().clashResult?.clashes.length, 1);

    const groups = s.get().clashGroups ?? [];
    // Under cluster grouping this single Y–Z clash would still be ONE group
    // (only one clash left, so type-pair partitioning cannot itself split
    // it further) — so `groups.length` alone cannot tell the algorithms
    // apart here. The title can: only the duplicate-set path titles a
    // `duplicates`-rule component "coincident".
    assert.strictEqual(groups.length, 1);
    assert.match(
      groups[0]?.title ?? '',
      /coincident/,
      'the re-derivation after an exclusion toggle must still use coincident-set grouping, not fall back to cluster grouping',
    );
  });
});
