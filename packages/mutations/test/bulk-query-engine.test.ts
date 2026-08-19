/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkQueryEngine, MutablePropertyView } from '../src/index.js';

/**
 * BulkQueryEngine.select() with propertyFilters exercises the private
 * matchesFilter/filterByProperty operator branches. This is the core
 * selection predicate for bulk edits: a broken operator silently selects
 * the wrong entity set and mass-mutates entities the user never intended.
 */
function makeEntities(count: number) {
  const expressId = new Int32Array(count);
  const typeEnum = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    expressId[i] = i + 1;
    typeEnum[i] = 10;
  }
  return {
    count,
    expressId,
    typeEnum,
    globalId: new Int32Array(count),
    name: new Int32Array(count),
  } as any;
}

/** Build an engine whose entities each carry `value` under Pset_Test/Prop. */
function makeEngineWithProperty(values: Array<string | number | boolean | null>) {
  const entities = makeEntities(values.length);
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor(() => []);

  values.forEach((value, i) => {
    const entityId = i + 1;
    if (value === null) return; // leave unset -> property absent
    const valueType =
      typeof value === 'string'
        ? PropertyValueType.Label
        : typeof value === 'number'
          ? PropertyValueType.Real
          : PropertyValueType.Boolean;
    view.setProperty(entityId, 'Pset_Test', 'Prop', value, valueType);
  });

  const engine = new BulkQueryEngine(entities, view, null, null, null);
  return engine;
}

/**
 * Build an engine with 6 entities spread across a small disjoint spatial
 * hierarchy: sites 100/200, buildings 10/20 (one per site), storeys 1/2
 * (one per building), and a space 500 nested inside storey 1.
 *
 *   site 100 -> building 10 -> storey 1 -> entities 1, 2 (entity 1 also in space 500)
 *   site 200 -> building 20 -> storey 2 -> entities 3, 4
 *   entities 5, 6 are not registered under any spatial container.
 */
function makeEngineWithSpatialHierarchy() {
  const entities = makeEntities(6);
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor(() => []);

  const spatialHierarchy = {
    project: { expressId: 0, type: 0, name: 'Project', children: [], elements: [] },
    byStorey: new Map([
      [1, [1, 2]],
      [2, [3, 4]],
    ]),
    byBuilding: new Map([
      [10, [1, 2]],
      [20, [3, 4]],
    ]),
    bySite: new Map([
      [100, [1, 2]],
      [200, [3, 4]],
    ]),
    bySpace: new Map([[500, [1]]]),
    storeyElevations: new Map(),
    storeyHeights: new Map(),
    elementToStorey: new Map(),
  } as any;

  return new BulkQueryEngine(entities, view, spatialHierarchy, null, null);
}

describe('BulkQueryEngine spatial filters', () => {
  it('sites filters to entities contained in the given site IDs (disjoint sites)', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ sites: [100] });
    expect(ids).toEqual([1, 2]);
  });

  it('sites with a second site ID includes both sites disjoint sets', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ sites: [100, 200] });
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it('sites excludes entities outside the requested site (regression: previously ignored, returned everything)', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ sites: [200] });
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).toEqual([3, 4]);
  });

  it('an empty sites array is treated as no filter, matching the storeys/buildings/spaces sibling behavior', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ sites: [] });
    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a site ID absent from bySite matches nothing for that ID', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ sites: [999] });
    expect(ids).toEqual([]);
  });

  it('sites combined with storeys intersects (not unions) the two criteria', () => {
    const engine = makeEngineWithSpatialHierarchy();
    // site 100 -> {1,2}; storey 2 -> {3,4}; intersection is empty.
    const ids = engine.select({ sites: [100], storeys: [2] });
    expect(ids).toEqual([]);
    // site 100 -> {1,2}; storey 1 -> {1,2}; intersection is {1,2}.
    const idsMatching = engine.select({ sites: [100], storeys: [1] });
    expect(idsMatching).toEqual([1, 2]);
  });

  it('storeys filters to entities contained in the given storey IDs', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ storeys: [1] });
    expect(ids).toEqual([1, 2]);
  });

  it('buildings filters to entities contained in the given building IDs', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ buildings: [20] });
    expect(ids).toEqual([3, 4]);
  });

  it('spaces filters to entities contained in the given space IDs', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ spaces: [500] });
    expect(ids).toEqual([1]);
  });
});

describe('BulkQueryEngine property filter operators', () => {
  describe('string operators', () => {
    const engine = makeEngineWithProperty(['Alpha', 'Beta', 'Gamma', null]);

    it('= matches exact string', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 'Beta' }],
      });
      expect(ids).toEqual([2]);
    });

    it('!= excludes the exact match but keeps unset entities excluded too (value required)', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '!=', value: 'Beta' }],
      });
      // Entity 4 has no property at all -> null value never matches non-null ops.
      expect(ids).toEqual([1, 3]);
    });

    it('CONTAINS is case-insensitive substring match', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'CONTAINS', value: 'amm' }],
      });
      expect(ids).toEqual([3]);
    });

    it('STARTS_WITH is case-insensitive prefix match', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'STARTS_WITH', value: 'al' }],
      });
      expect(ids).toEqual([1]);
    });

    it('ENDS_WITH is case-insensitive suffix match', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'ENDS_WITH', value: 'MA' }],
      });
      expect(ids).toEqual([3]);
    });

    it('IS_NULL selects only entities missing the property', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'IS_NULL' }],
      });
      expect(ids).toEqual([4]);
    });

    it('IS_NOT_NULL selects only entities that have the property', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'IS_NOT_NULL' }],
      });
      expect(ids).toEqual([1, 2, 3]);
    });
  });

  describe('numeric operators', () => {
    const engine = makeEngineWithProperty([10, 20, 30]);

    it('= matches exact number', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 20 }] })
      ).toEqual([2]);
    });

    it('!= excludes the exact number', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '!=', value: 20 }] })
      ).toEqual([1, 3]);
    });

    it('> selects strictly greater values', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '>', value: 20 }] })
      ).toEqual([3]);
    });

    it('< selects strictly lesser values', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '<', value: 20 }] })
      ).toEqual([1]);
    });

    it('>= includes the boundary value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '>=', value: 20 }] })
      ).toEqual([2, 3]);
    });

    it('<= includes the boundary value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '<=', value: 20 }] })
      ).toEqual([1, 2]);
    });
  });

  describe('boolean operators', () => {
    const engine = makeEngineWithProperty([true, false, true]);

    it('= matches the boolean value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: true }] })
      ).toEqual([1, 3]);
    });

    it('!= matches the opposite boolean value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '!=', value: true }] })
      ).toEqual([2]);
    });

    it('= accepts a string "true"/"false" filter value (UI form input)', () => {
      expect(
        engine.select({
          propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 'false' as any }],
        })
      ).toEqual([2]);
    });

    it('= with filter value "true" (string) coerces to boolean true, not just falls through to false', () => {
      // The 'false' case above passes even without the `filterValue === 'true'`
      // coercion arm, because a non-coerced comparison also lands on
      // boolFilterValue=false for the literal string 'false'. Only the
      // 'true' string actually exercises the coercion: without it,
      // boolFilterValue would incorrectly stay false and this would select
      // entity 2 (the false entity) instead of 1 and 3.
      expect(
        engine.select({
          propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 'true' as any }],
        })
      ).toEqual([1, 3]);
    });
  });

  /**
   * The three switches in matchesFilter() are keyed on typeof(value) &&
   * typeof(filterValue) (string/string, number/number) or typeof(value)
   * alone (boolean). A mismatch between the stored property's type and the
   * filter's value type must fall through to the final `return false` —
   * never throw, never coerce. The boolean branch is the one exception: it
   * deliberately coerces a string filter value ('true'/'false') to match a
   * boolean property, tested above. Numeric and string operators must NOT
   * do the equivalent coercion.
   */
  describe('operator/value-type mismatches', () => {
    it('numeric operator (>) given a string property value never matches, even when numerically true', () => {
      // '30' > '20' would be true under numeric coercion; matchesFilter must
      // not enter the numeric switch because typeof value is 'string'.
      const engine = makeEngineWithProperty(['30']);
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '>', value: 20 }],
      });
      expect(ids).toEqual([]);
    });

    it('a numeric property value against a string filter value does not coerce for >', () => {
      // 20 > '15' would be true under JS's relational coercion (numeric
      // switch's own case bodies don't re-check types); matchesFilter must
      // never enter the numeric switch at all when typeof filterValue is
      // 'string' rather than 'number', so this must not match.
      const engine = makeEngineWithProperty([20]);
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '>', value: '15' as any }],
      });
      expect(ids).toEqual([]);
    });

    it('string operator (CONTAINS) given a numeric filter value never matches', () => {
      const engine = makeEngineWithProperty(['Beta']);
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'CONTAINS', value: 5 as any }],
      });
      expect(ids).toEqual([]);
    });

    it('boolean property value against a non-string, non-boolean filter value (a number) never matches =', () => {
      const engine = makeEngineWithProperty([true]);
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 1 as any }],
      });
      // boolFilterValue = (1 === true || 1 === 'true') = false, so true !== false -> no match.
      expect(ids).toEqual([]);
    });

    it('a boolean-typed operator (=) given a missing/null property value never matches (not IS_NULL)', () => {
      // Entity has no property at all -> value resolves to null. matchesFilter
      // short-circuits null handling to IS_NULL/IS_NOT_NULL only; '=' against
      // a null value must fail closed rather than throw or coerce.
      const engine = makeEngineWithProperty([null]);
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: true }],
      });
      expect(ids).toEqual([]);
    });

    it('a numeric-only operator (>) applied to a boolean value never matches (cross-switch leak check)', () => {
      const engine = makeEngineWithProperty([true]);
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '>', value: true as any }],
      });
      expect(ids).toEqual([]);
    });

    it('a string-only operator (STARTS_WITH) applied to a numeric value never matches (cross-switch leak check)', () => {
      const engine = makeEngineWithProperty([42]);
      const ids = engine.select({
        propertyFilters: [
          { psetName: 'Pset_Test', propName: 'Prop', operator: 'STARTS_WITH', value: '4' as any },
        ],
      });
      expect(ids).toEqual([]);
    });

    it("the string switch's own default arm rejects a numeric-only operator (>) given two string operands", () => {
      // Both operands are strings, so this enters the string switch (not a
      // cross-switch case) — '>' isn't one of its cases, so it must hit that
      // switch's own `default: return false`, not silently match everything.
      const engine = makeEngineWithProperty(['30']);
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '>', value: '20' as any }],
      });
      expect(ids).toEqual([]);
    });

    it("the numeric switch's own default arm rejects a string-only operator (CONTAINS) given two number operands", () => {
      // Both operands are numbers, so this enters the numeric switch —
      // CONTAINS isn't one of its cases, so it must hit that switch's own
      // `default: return false`, not silently match everything.
      const engine = makeEngineWithProperty([30]);
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'CONTAINS', value: 3 as any }],
      });
      expect(ids).toEqual([]);
    });
  });
});

describe('BulkQueryEngine.applyAction / action.type switch', () => {
  function makeEngine() {
    const entities = makeEntities(1);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const engine = new BulkQueryEngine(entities, view, null, null, null);
    return { engine, view };
  }

  it('SET_PROPERTY creates a property mutation for entity 1', () => {
    const { engine } = makeEngine();
    const mutation = engine.applyAction(1, {
      type: 'SET_PROPERTY',
      psetName: 'Pset_Test',
      propName: 'Prop',
      value: 'hello',
      valueType: PropertyValueType.Label,
    });
    expect(mutation).not.toBeNull();
    expect(mutation!.entityId).toBe(1);
    expect(mutation!.newValue).toBe('hello');
  });

  it('DELETE_PROPERTY on a property that was never set returns null (nothing to delete)', () => {
    const { engine } = makeEngine();
    const mutation = engine.applyAction(1, {
      type: 'DELETE_PROPERTY',
      psetName: 'Pset_Test',
      propName: 'Prop',
    });
    expect(mutation).toBeNull();
  });

  it('DELETE_PROPERTY on a property that was set produces a mutation', () => {
    const { engine } = makeEngine();
    engine.applyAction(1, {
      type: 'SET_PROPERTY',
      psetName: 'Pset_Test',
      propName: 'Prop',
      value: 'hello',
      valueType: PropertyValueType.Label,
    });
    const mutation = engine.applyAction(1, {
      type: 'DELETE_PROPERTY',
      psetName: 'Pset_Test',
      propName: 'Prop',
    });
    expect(mutation).not.toBeNull();
  });

  it('SET_ATTRIBUTE is unimplemented and always returns null, silently no-oping the selected entity', () => {
    // Documents current behavior (see the "not implemented" comment on this
    // arm in bulk-query-engine.ts): a bulk action targeting name/description/
    // objectType selects entities but produces zero mutations for them.
    const { engine } = makeEngine();
    const mutation = engine.applyAction(1, {
      type: 'SET_ATTRIBUTE',
      attribute: 'name',
      value: 'New Name',
    });
    expect(mutation).toBeNull();
  });

  it('SET_ENTITY_TYPE produces an entity-type mutation', () => {
    const { engine } = makeEngine();
    const mutation = engine.applyAction(1, {
      type: 'SET_ENTITY_TYPE',
      entityType: 'IfcColumn',
      predefinedType: null,
    });
    expect(mutation).not.toBeNull();
    expect(mutation!.entityId).toBe(1);
    expect(mutation!.entityType).toBe('IfcColumn');
  });

  it('an unknown action.type falls to the default arm and returns null rather than throwing or matching a known type', () => {
    const { engine } = makeEngine();
    const mutation = engine.applyAction(1, { type: 'NOT_A_REAL_ACTION' } as any);
    expect(mutation).toBeNull();
  });
});
