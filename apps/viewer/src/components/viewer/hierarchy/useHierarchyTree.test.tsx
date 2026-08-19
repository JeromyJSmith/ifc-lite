/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useHierarchyTree.ts` had no tests at all, unlike its sibling
 * `treeDataBuilder.ts` (the tree-construction logic it wires to store and DOM
 * state). This file pins:
 *
 *  - `buildGeometricIdSet` and `collectAnnotationEntityIds` (both exported
 *    from the hook module specifically so they can be unit-tested directly,
 *    rather than only observable through the hook's `treeData`).
 *  - The checkable claim in `collectAnnotationEntityIds`'s doc comment: "Text
 *    annotations that carry a real brep mesh are already in the geometric
 *    set, so the union is idempotent for them."
 *  - `getNodeElements`, a six-branch dispatch over `node.type`, exercised
 *    through the real hook (it closes over `models`/`ifcDataStore`/
 *    `unifiedStoreys`, so it can't be extracted as a pure function) with one
 *    test per branch and hand-built `TreeNode` fixtures so each branch's own
 *    id-resolution path is what's under test, not `treeDataBuilder`'s.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { federationRegistry } from '@ifc-lite/renderer';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { SpatialHierarchy } from '@ifc-lite/data';
import { useViewerStore, type FederatedModel } from '@/store/index.js';
import type { TreeNode } from './types.js';
import {
  useHierarchyTree,
  buildGeometricIdSet,
  collectAnnotationEntityIds,
} from './useHierarchyTree.js';

// ─── shared fixtures ────────────────────────────────────────────────────

function mesh(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.1, 0.2, 0.3, 1],
    ifcType: 'IFCWALL',
    geometryClass: 0,
    origin: [0, 0, 0],
  } as unknown as MeshData;
}

function geometryResult(expressIds: number[]): GeometryResult {
  return { meshes: expressIds.map(mesh) } as unknown as GeometryResult;
}

function federatedModel(id: string, overrides: Partial<FederatedModel> = {}): FederatedModel {
  return {
    id,
    name: id,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    ...overrides,
  } as unknown as FederatedModel;
}

interface AnnotationEntity { expressId: number }

/** A minimal `IfcDataStore` whose only job is to answer `getEntitiesByType('IfcAnnotation')`. */
function annotationStore(entityIds: number[]): IfcDataStore {
  return {
    getEntitiesByType: (typeName: string): AnnotationEntity[] =>
      typeName === 'IfcAnnotation' ? entityIds.map((expressId) => ({ expressId })) : [],
  } as unknown as IfcDataStore;
}

// ─── buildGeometricIdSet ────────────────────────────────────────────────

describe('buildGeometricIdSet', () => {
  it('unions mesh expressIds across every federated model, not just the first', () => {
    const models = new Map([
      ['model-a', federatedModel('model-a', { geometryResult: geometryResult([11, 12]) })],
      ['model-b', federatedModel('model-b', { geometryResult: geometryResult([21, 22, 23]) })],
    ]);
    const ids = buildGeometricIdSet(models, null);
    assert.deepEqual([...ids].sort((a, b) => a - b), [11, 12, 21, 22, 23]);
  });

  it('skips a model with no geometryResult without dropping the others', () => {
    const models = new Map([
      ['model-a', federatedModel('model-a', { geometryResult: geometryResult([11]) })],
      ['model-b', federatedModel('model-b', { geometryResult: null })],
    ]);
    const ids = buildGeometricIdSet(models, null);
    assert.deepEqual([...ids], [11]);
  });

  it('falls back to the legacy single-model geometry when no federated models are loaded', () => {
    const ids = buildGeometricIdSet(new Map(), geometryResult([31, 32]));
    assert.deepEqual([...ids].sort((a, b) => a - b), [31, 32]);
  });

  it('ignores legacy geometry once federated models are present', () => {
    const models = new Map([['model-a', federatedModel('model-a', { geometryResult: geometryResult([11]) })]]);
    const ids = buildGeometricIdSet(models, geometryResult([999]));
    assert.deepEqual([...ids], [11]);
  });

  it('returns an empty set when there is no geometry source at all', () => {
    assert.equal(buildGeometricIdSet(new Map(), null).size, 0);
  });
});

// ─── collectAnnotationEntityIds ─────────────────────────────────────────

describe('collectAnnotationEntityIds', () => {
  it('reads straight from the legacy store (identity mapping) when no federated models are loaded', () => {
    const ids = collectAnnotationEntityIds(new Map(), annotationStore([41, 42]));
    assert.deepEqual([...ids].sort((a, b) => a - b), [41, 42]);
  });

  it('converts each model-local annotation id through the real federation offset, per model', () => {
    // Distinct, non-zero offsets so a test that silently used the wrong
    // model's offset (or skipped the conversion) would fail.
    const offsetA = federationRegistry.registerModel('hierarchy-tree-test-annot-a', 100);
    const offsetB = federationRegistry.registerModel('hierarchy-tree-test-annot-b', 100);
    try {
      const models = new Map([
        ['hierarchy-tree-test-annot-a', federatedModel('hierarchy-tree-test-annot-a', { ifcDataStore: annotationStore([5]) })],
        ['hierarchy-tree-test-annot-b', federatedModel('hierarchy-tree-test-annot-b', { ifcDataStore: annotationStore([7]) })],
      ]);
      const ids = collectAnnotationEntityIds(models, null);
      assert.deepEqual(
        [...ids].sort((a, b) => a - b),
        [5 + offsetA, 7 + offsetB].sort((a, b) => a - b),
      );
    } finally {
      federationRegistry.unregisterModel('hierarchy-tree-test-annot-a');
      federationRegistry.unregisterModel('hierarchy-tree-test-annot-b');
    }
  });

  it('uses the raw local id for the legacy sentinel model even inside a federated models map', () => {
    // Register 'legacy' itself with a non-zero offset — if the sentinel check
    // were ever dropped, this would convert like any other model and the
    // assertion below would see 9 + offset instead of the raw 9.
    const offset = federationRegistry.registerModel('legacy', 100);
    try {
      assert.notEqual(offset, 0, 'the fixture needs a real offset for this test to discriminate');
      const models = new Map([['legacy', federatedModel('legacy', { ifcDataStore: annotationStore([9]) })]]);
      const ids = collectAnnotationEntityIds(models, null);
      assert.deepEqual([...ids], [9]);
    } finally {
      federationRegistry.unregisterModel('legacy');
    }
  });

  it('guards a store whose lazy accessors have not been reattached (cache-restored)', () => {
    const bareStore = {} as unknown as IfcDataStore;
    const ids = collectAnnotationEntityIds(new Map(), bareStore);
    assert.equal(ids.size, 0);
  });

  // ─── the doc-comment claim ─────────────────────────────────────────
  //
  // "Text annotations that carry a real brep mesh are already in the
  // geometric set, so the union is idempotent for them." Reproduced here as
  // the hook itself computes it (useHierarchyTree.ts:252-257: start from
  // geometricIds, add every annotation id).
  function union(geometric: Set<number>, annotations: Set<number>): Set<number> {
    if (annotations.size === 0) return geometric;
    const merged = new Set(geometric);
    for (const id of annotations) merged.add(id);
    return merged;
  }

  it('idempotency claim holds: a mesh-backed annotation id adds nothing new to the geometric set', () => {
    const geometric = buildGeometricIdSet(
      new Map(),
      geometryResult([50]), // annotation #50 also has a real brep mesh
    );
    const annotations = collectAnnotationEntityIds(new Map(), annotationStore([50]));
    const merged = union(geometric, annotations);
    assert.deepEqual([...merged], [...geometric], 'merging a mesh-backed annotation id must not change the set');
  });

  it('a curve-only annotation (no mesh) is genuinely new after the union, unlike the mesh-backed case', () => {
    const geometric = buildGeometricIdSet(new Map(), geometryResult([50]));
    const annotations = collectAnnotationEntityIds(new Map(), annotationStore([50, 60]));
    const merged = union(geometric, annotations);
    assert.deepEqual([...merged].sort((a, b) => a - b), [50, 60]);
  });
});

// ─── getNodeElements (via the real hook) ────────────────────────────────

function spatialHierarchy(overrides: Partial<SpatialHierarchy> = {}): SpatialHierarchy {
  return {
    project: null as unknown as SpatialHierarchy['project'],
    byStorey: new Map(),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map(),
    storeyElevations: new Map(),
    storeyHeights: new Map(),
    elementToStorey: new Map(),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [],
    ...overrides,
  };
}

function baseNode(overrides: Partial<TreeNode>): TreeNode {
  return {
    id: 'node-1',
    expressIds: [],
    globalIds: [],
    modelIds: [],
    name: 'node',
    type: 'element',
    depth: 0,
    hasChildren: false,
    isExpanded: false,
    isVisible: true,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
// biome-ignore lint/suspicious/noExplicitAny: captured hook return, typed at each read site
let api: ReturnType<typeof useHierarchyTree> | null = null;

function Harness(props: Parameters<typeof useHierarchyTree>[0]) {
  api = useHierarchyTree(props);
  return null;
}

function mount(props: Parameters<typeof useHierarchyTree>[0]): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness {...props} />);
  });
}

beforeEach(() => {
  api = null;
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('getNodeElements', () => {
  it('type-group / ifc-type / material-group / group / group-member: returns the pre-stored globalIds as-is', () => {
    mount({ models: new Map(), ifcDataStore: null, isMultiModel: false });
    const globalIds = [101, 102, 103];
    for (const type of ['type-group', 'ifc-type', 'material-group', 'group', 'group-member'] as const) {
      const result = api!.getNodeElements(baseNode({ type, globalIds }));
      assert.deepEqual(result, globalIds, `branch for '${type}' must return node.globalIds`);
    }
  });

  it('unified-storey: resolves through the real unifiedStoreys + federation offsets, summed across models', () => {
    const offsetB = federationRegistry.registerModel('hierarchy-tree-test-unified-b', 100);
    try {
      const hierarchyA = spatialHierarchy({
        byStorey: new Map([[10, [200, 201]]]),
        storeyElevations: new Map([[10, 0]]),
      });
      const hierarchyB = spatialHierarchy({
        byStorey: new Map([[11, [300]]]),
        storeyElevations: new Map([[11, 0]]), // same elevation -> unified with A's storey
      });
      const storeA: IfcDataStore = {
        spatialHierarchy: hierarchyA,
        entities: { getName: () => 'Level 1' },
      } as unknown as IfcDataStore;
      const storeB: IfcDataStore = {
        spatialHierarchy: hierarchyB,
        entities: { getName: () => 'Level 1' },
      } as unknown as IfcDataStore;

      const models = new Map([
        ['hierarchy-tree-test-unified-a', federatedModel('hierarchy-tree-test-unified-a', { ifcDataStore: storeA })],
        ['hierarchy-tree-test-unified-b', federatedModel('hierarchy-tree-test-unified-b', { ifcDataStore: storeB })],
      ]);
      mount({ models, ifcDataStore: null, isMultiModel: true });

      assert.equal(api!.unifiedStoreys.length, 1, 'both storeys share elevation 0 and must unify into one entry');
      const unifiedId = `unified-${api!.unifiedStoreys[0]!.key}`;
      const result = api!.getNodeElements(baseNode({ type: 'unified-storey', id: unifiedId }));
      assert.deepEqual(
        result.sort((a, b) => a - b),
        [200, 201, 300 + offsetB].sort((a, b) => a - b),
      );
    } finally {
      federationRegistry.unregisterModel('hierarchy-tree-test-unified-b');
    }
  });

  it("unified-storey: an id that doesn't match any unified storey falls through to the empty default", () => {
    mount({ models: new Map(), ifcDataStore: null, isMultiModel: true });
    const result = api!.getNodeElements(baseNode({ type: 'unified-storey', id: 'unified-does-not-exist' }));
    assert.deepEqual(result, []);
  });

  it('model-header (contrib-*): looks up the named model\'s storey and applies its federation offset', () => {
    const offset = federationRegistry.registerModel('hierarchy-tree-test-contrib', 100);
    try {
      const store: IfcDataStore = {
        spatialHierarchy: spatialHierarchy({ byStorey: new Map([[20, [400, 401]]]) }),
      } as unknown as IfcDataStore;
      const models = new Map([
        ['hierarchy-tree-test-contrib', federatedModel('hierarchy-tree-test-contrib', { ifcDataStore: store })],
      ]);
      mount({ models, ifcDataStore: null, isMultiModel: true });
      const node = baseNode({
        type: 'model-header',
        id: 'contrib-hierarchy-tree-test-contrib-20',
        expressIds: [20],
        modelIds: ['hierarchy-tree-test-contrib'],
      });
      const result = api!.getNodeElements(node);
      assert.deepEqual(result.sort((a, b) => a - b), [400 + offset, 401 + offset].sort((a, b) => a - b));
    } finally {
      federationRegistry.unregisterModel('hierarchy-tree-test-contrib');
    }
  });

  it('IfcBuildingStorey (legacy sentinel): reads straight off ifcDataStore.spatialHierarchy, unconverted', () => {
    const legacyStore: IfcDataStore = {
      spatialHierarchy: spatialHierarchy({ byStorey: new Map([[30, [500, 501]]]) }),
    } as unknown as IfcDataStore;
    mount({ models: new Map(), ifcDataStore: legacyStore, isMultiModel: false });
    const node = baseNode({ type: 'IfcBuildingStorey', expressIds: [30], modelIds: ['legacy'] });
    const result = api!.getNodeElements(node);
    assert.deepEqual(result, [500, 501]);
  });

  it('IfcBuildingStorey (federated model): looks up the model, not the legacy store, and applies its offset', () => {
    const offset = federationRegistry.registerModel('hierarchy-tree-test-storey', 1000);
    try {
      const store: IfcDataStore = {
        spatialHierarchy: spatialHierarchy({ byStorey: new Map([[31, [600]]]) }),
      } as unknown as IfcDataStore;
      const models = new Map([
        ['hierarchy-tree-test-storey', federatedModel('hierarchy-tree-test-storey', { ifcDataStore: store })],
      ]);
      // Legacy store present too, with a DIFFERENT answer for storey 31 — if the
      // branch read the legacy store instead of the named model, this would catch it.
      const legacyStore: IfcDataStore = {
        spatialHierarchy: spatialHierarchy({ byStorey: new Map([[31, [999]]]) }),
      } as unknown as IfcDataStore;
      mount({ models, ifcDataStore: legacyStore, isMultiModel: true });
      const node = baseNode({ type: 'IfcBuildingStorey', expressIds: [31], modelIds: ['hierarchy-tree-test-storey'] });
      const result = api!.getNodeElements(node);
      assert.deepEqual(result, [600 + offset]);
    } finally {
      federationRegistry.unregisterModel('hierarchy-tree-test-storey');
    }
  });

  it('IfcSpace (legacy sentinel): prepends the space id itself to its contained elements', () => {
    const legacyStore: IfcDataStore = {
      spatialHierarchy: spatialHierarchy({ bySpace: new Map([[40, [700, 701]]]) }),
    } as unknown as IfcDataStore;
    mount({ models: new Map(), ifcDataStore: legacyStore, isMultiModel: false });
    const node = baseNode({ type: 'IfcSpace', expressIds: [40], modelIds: ['legacy'] });
    const result = api!.getNodeElements(node);
    assert.deepEqual(result, [40, 700, 701]);
  });

  it('IfcSpatialZone (federated model): unions node.globalIds with the offset-converted contained elements', () => {
    const offset = federationRegistry.registerModel('hierarchy-tree-test-space', 1000);
    try {
      const store: IfcDataStore = {
        spatialHierarchy: spatialHierarchy({ bySpace: new Map([[41, [800]]]) }),
      } as unknown as IfcDataStore;
      const models = new Map([
        ['hierarchy-tree-test-space', federatedModel('hierarchy-tree-test-space', { ifcDataStore: store })],
      ]);
      mount({ models, ifcDataStore: null, isMultiModel: true });
      const node = baseNode({
        type: 'IfcSpatialZone',
        expressIds: [41],
        modelIds: ['hierarchy-tree-test-space'],
        globalIds: [41 + offset], // the node's own pre-resolved global id
      });
      const result = api!.getNodeElements(node);
      assert.deepEqual(result.sort((a, b) => a - b), [41 + offset, 800 + offset].sort((a, b) => a - b));
    } finally {
      federationRegistry.unregisterModel('hierarchy-tree-test-space');
    }
  });

  it('element: returns just globalIds when the element does not decompose', () => {
    mount({ models: new Map(), ifcDataStore: null, isMultiModel: false });
    const node = baseNode({ type: 'element', globalIds: [900] });
    assert.deepEqual(api!.getNodeElements(node), [900]);
  });

  it('element: folds in assemblyChildGlobalIds for a decomposing assembly, assembly id first', () => {
    mount({ models: new Map(), ifcDataStore: null, isMultiModel: false });
    const node = baseNode({ type: 'element', globalIds: [900], assemblyChildGlobalIds: [901, 902] });
    assert.deepEqual(api!.getNodeElements(node), [900, 901, 902]);
  });

  it('spatial containers (default branch): Project/Site/Building have no direct element visibility toggle', () => {
    mount({ models: new Map(), ifcDataStore: null, isMultiModel: false });
    for (const type of ['IfcProject', 'IfcSite', 'IfcBuilding'] as const) {
      const result = api!.getNodeElements(baseNode({ type, globalIds: [1, 2, 3] }));
      assert.deepEqual(result, [], `'${type}' must fall through to the empty default, not return globalIds`);
    }
  });
});
