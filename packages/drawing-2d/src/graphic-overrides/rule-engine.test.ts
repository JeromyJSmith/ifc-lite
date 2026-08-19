/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  GraphicOverrideEngine,
  createOverrideEngine,
  ifcTypeCriterion,
  propertyCriterion,
  andCriteria,
  orCriteria,
} from './rule-engine.js';
import type {
  ElementData,
  GraphicOverrideRule,
  OverrideCriterion,
  OverrideCriteria,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════════════════════════

function element(overrides: Partial<ElementData> = {}): ElementData {
  return {
    expressId: 1,
    ifcType: 'IfcWall',
    ...overrides,
  };
}

function rule(overrides: Partial<GraphicOverrideRule> = {}): GraphicOverrideRule {
  return {
    id: 'r1',
    name: 'rule',
    enabled: true,
    priority: 0,
    criteria: { type: 'all' },
    style: {},
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIORITY ORDERING
// ═══════════════════════════════════════════════════════════════════════════

describe('priority ordering', () => {
  it('applies the higher-priority rule last so it wins a conflicting field', () => {
    const engine = createOverrideEngine([
      rule({ id: 'low', priority: 1, style: { strokeColor: '#111111' } }),
      rule({ id: 'high', priority: 10, style: { strokeColor: '#999999' } }),
    ]);

    const result = engine.applyOverrides(element());

    // Both rules match (criteria: 'all'), so this fixture CAN distinguish
    // priority ordering from "only one rule matched".
    expect(result.matchedRules.map((r) => r.id)).toEqual(['low', 'high']);
    expect(result.style.strokeColor).toBe('#999999');
  });

  it('applies rules regardless of insertion order, sorted by ascending priority', () => {
    // Insert the high-priority rule FIRST to prove sorting, not insertion order, governs.
    const engine = createOverrideEngine([
      rule({ id: 'high', priority: 10, style: { strokeColor: '#999999' } }),
      rule({ id: 'low', priority: 1, style: { strokeColor: '#111111' } }),
    ]);

    const result = engine.applyOverrides(element());

    expect(result.matchedRules.map((r) => r.id)).toEqual(['low', 'high']);
    expect(result.style.strokeColor).toBe('#999999');
  });

  it('ties: equal-priority rules apply in the order they were added (stable sort)', () => {
    const engine = new GraphicOverrideEngine();
    engine.addRule(rule({ id: 'a', priority: 5, style: { strokeColor: '#aaaaaa' } }));
    engine.addRule(rule({ id: 'b', priority: 5, style: { strokeColor: '#bbbbbb' } }));

    const result = engine.applyOverrides(element());

    expect(result.matchedRules.map((r) => r.id)).toEqual(['a', 'b']);
    // b was added after a, so with a stable sort it cascades on top and wins.
    expect(result.style.strokeColor).toBe('#bbbbbb');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CASCADE (merge vs overwrite)
// ═══════════════════════════════════════════════════════════════════════════

describe('cascade semantics', () => {
  it('merges fields across matching rules instead of the last match replacing the whole style', () => {
    const engine = createOverrideEngine([
      rule({ id: 'fill', priority: 1, style: { fillColor: '#ff0000' } }),
      rule({ id: 'stroke', priority: 2, style: { strokeColor: '#00ff00' } }),
    ]);

    const result = engine.applyOverrides(element());

    // If the cascade replaced wholesale, fillColor would have reverted to default.
    expect(result.style.fillColor).toBe('#ff0000');
    expect(result.style.strokeColor).toBe('#00ff00');
  });

  it('a later rule overrides an earlier rule on the same field (last-writer-wins in application order)', () => {
    const engine = createOverrideEngine([
      rule({ id: 'first', priority: 1, style: { visible: false } }),
      rule({ id: 'second', priority: 2, style: { visible: true } }),
    ]);

    const result = engine.applyOverrides(element());
    expect(result.style.visible).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OPERATOR BRANCHES
// ═══════════════════════════════════════════════════════════════════════════

describe('property criterion operators', () => {
  function withProp(value: unknown): ElementData {
    return element({ properties: { Pset_Common: { Mark: value } } });
  }

  function matches(el: ElementData, operator: OverrideCriterion['operator'], value: unknown): boolean {
    const engine = createOverrideEngine([
      rule({ criteria: propertyCriterion('Mark', operator!, value) }),
    ]);
    return engine.getMatchingRules(el).length === 1;
  }

  it('equals: true on match, false on mismatch', () => {
    expect(matches(withProp('W1'), 'equals', 'W1')).toBe(true);
    expect(matches(withProp('W1'), 'equals', 'W2')).toBe(false);
  });

  it('notEquals: false on match, true on mismatch', () => {
    expect(matches(withProp('W1'), 'notEquals', 'W1')).toBe(false);
    expect(matches(withProp('W1'), 'notEquals', 'W2')).toBe(true);
  });

  it('contains: case-insensitive substring match', () => {
    expect(matches(withProp('Exterior Wall'), 'contains', 'exterior')).toBe(true);
    expect(matches(withProp('Interior Wall'), 'contains', 'exterior')).toBe(false);
  });

  it('notContains: inverse of contains', () => {
    expect(matches(withProp('Exterior Wall'), 'notContains', 'exterior')).toBe(false);
    expect(matches(withProp('Interior Wall'), 'notContains', 'exterior')).toBe(true);
  });

  it('startsWith: case-insensitive prefix match', () => {
    expect(matches(withProp('WallType-A'), 'startsWith', 'walltype')).toBe(true);
    expect(matches(withProp('WallType-A'), 'startsWith', 'type')).toBe(false);
  });

  it('endsWith: case-insensitive suffix match', () => {
    expect(matches(withProp('WallType-A'), 'endsWith', '-a')).toBe(true);
    expect(matches(withProp('WallType-A'), 'endsWith', '-b')).toBe(false);
  });

  it('greaterThan / lessThan: strict numeric comparison', () => {
    expect(matches(withProp(5), 'greaterThan', 3)).toBe(true);
    expect(matches(withProp(5), 'greaterThan', 5)).toBe(false);
    expect(matches(withProp(3), 'lessThan', 5)).toBe(true);
    expect(matches(withProp(5), 'lessThan', 5)).toBe(false);
  });

  it('greaterOrEqual / lessOrEqual: inclusive numeric comparison', () => {
    expect(matches(withProp(5), 'greaterOrEqual', 5)).toBe(true);
    expect(matches(withProp(4), 'greaterOrEqual', 5)).toBe(false);
    expect(matches(withProp(5), 'lessOrEqual', 5)).toBe(true);
    expect(matches(withProp(6), 'lessOrEqual', 5)).toBe(false);
  });

  it('exists / notExists: presence of the property value', () => {
    expect(matches(withProp('x'), 'exists', undefined)).toBe(true);
    expect(matches(element(), 'exists', undefined)).toBe(false);
    expect(matches(withProp('x'), 'notExists', undefined)).toBe(false);
    expect(matches(element(), 'notExists', undefined)).toBe(true);
  });

  it('in / notIn: membership in an expected array', () => {
    expect(matches(withProp('B'), 'in', ['A', 'B', 'C'])).toBe(true);
    expect(matches(withProp('D'), 'in', ['A', 'B', 'C'])).toBe(false);
    expect(matches(withProp('D'), 'notIn', ['A', 'B', 'C'])).toBe(true);
    expect(matches(withProp('B'), 'notIn', ['A', 'B', 'C'])).toBe(false);
  });

  it('numeric operators fall back to false when either side is not a number', () => {
    expect(matches(withProp('5'), 'greaterThan', 3)).toBe(false);
  });

  it('property lookup with no propertySet searches all property sets, and an earlier pset lacking the key does not shadow a later one', () => {
    const el = element({
      properties: {
        Pset_Empty: { OtherKey: 'ignored' },
        Pset_Common: { Mark: 'W1' },
      },
    });
    expect(matches(el, 'equals', 'W1')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUBTYPE-HIERARCHY MATCHING
// ═══════════════════════════════════════════════════════════════════════════

describe('ifcType subtype matching', () => {
  it('a supertype rule with includeSubtypes matches a direct subtype', () => {
    const engine = createOverrideEngine([
      rule({ criteria: ifcTypeCriterion(['IfcWall'], true) }),
    ]);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcWallStandardCase' }))).toHaveLength(1);
  });

  it('a supertype rule with includeSubtypes does NOT match an unrelated sibling type', () => {
    const engine = createOverrideEngine([
      rule({ criteria: ifcTypeCriterion(['IfcWall'], true) }),
    ]);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcSlabStandardCase' }))).toHaveLength(0);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcSlab' }))).toHaveLength(0);
  });

  it('subtype matching recurses two levels (IfcBuildingElement -> IfcWall -> IfcWallStandardCase)', () => {
    const engine = createOverrideEngine([
      rule({ criteria: ifcTypeCriterion(['IfcBuildingElement'], true) }),
    ]);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcWallStandardCase' }))).toHaveLength(1);
  });

  it('without includeSubtypes, only the exact type matches', () => {
    const engine = createOverrideEngine([
      rule({ criteria: ifcTypeCriterion(['IfcWall'], false) }),
    ]);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcWallStandardCase' }))).toHaveLength(0);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcWall' }))).toHaveLength(1);
  });

  it('exact type match is case-insensitive', () => {
    const engine = createOverrideEngine([
      rule({ criteria: ifcTypeCriterion(['ifcwall'], false) }),
    ]);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcWall' }))).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OTHER CRITERION TYPES
// ═══════════════════════════════════════════════════════════════════════════

describe('other criterion types', () => {
  it('material: case-insensitive substring match against any of the element materials', () => {
    const engine = createOverrideEngine([
      rule({ criteria: { type: 'material', materialNames: ['concrete'] } }),
    ]);
    expect(engine.getMatchingRules(element({ materials: ['Reinforced Concrete'] }))).toHaveLength(1);
    expect(engine.getMatchingRules(element({ materials: ['Steel'] }))).toHaveLength(0);
    expect(engine.getMatchingRules(element({}))).toHaveLength(0);
  });

  it('layer: case-insensitive substring match against any of the element layers', () => {
    const engine = createOverrideEngine([
      rule({ criteria: { type: 'layer', layerNames: ['A-WALL'] } }),
    ]);
    expect(engine.getMatchingRules(element({ layers: ['a-wall-ext'] }))).toHaveLength(1);
    expect(engine.getMatchingRules(element({ layers: ['a-door'] }))).toHaveLength(0);
  });

  it('expressId: matches by membership in the id list', () => {
    const engine = createOverrideEngine([
      rule({ criteria: { type: 'expressId', expressIds: [42] } }),
    ]);
    expect(engine.getMatchingRules(element({ expressId: 42 }))).toHaveLength(1);
    expect(engine.getMatchingRules(element({ expressId: 43 }))).toHaveLength(0);
  });

  it('modelId: matches by membership in the id list, absent when element has no modelId', () => {
    const engine = createOverrideEngine([
      rule({ criteria: { type: 'modelId', modelIds: ['modelA'] } }),
    ]);
    expect(engine.getMatchingRules(element({ modelId: 'modelA' }))).toHaveLength(1);
    expect(engine.getMatchingRules(element({ modelId: 'modelB' }))).toHaveLength(0);
    expect(engine.getMatchingRules(element({}))).toHaveLength(0);
  });

  it("'all' criterion matches every element unconditionally", () => {
    const engine = createOverrideEngine([rule({ criteria: { type: 'all' } })]);
    expect(engine.getMatchingRules(element({ ifcType: 'AnythingAtAll' }))).toHaveLength(1);
  });

  it('propertySet: exists / notExists on presence of a named property set', () => {
    const el = element({ properties: { Pset_Common: {} } });
    const existsEngine = createOverrideEngine([
      rule({ criteria: { type: 'propertySet', propertySet: 'Pset_Common', operator: 'exists' } }),
    ]);
    const notExistsEngine = createOverrideEngine([
      rule({ criteria: { type: 'propertySet', propertySet: 'Pset_Missing', operator: 'notExists' } }),
    ]);
    expect(existsEngine.getMatchingRules(el)).toHaveLength(1);
    expect(notExistsEngine.getMatchingRules(el)).toHaveLength(1);
  });

  it('propertySet: with no properties on the element at all, only notExists matches', () => {
    const notExistsEngine = createOverrideEngine([
      rule({ criteria: { type: 'propertySet', propertySet: 'Pset_X', operator: 'notExists' } }),
    ]);
    const existsEngine = createOverrideEngine([
      rule({ criteria: { type: 'propertySet', propertySet: 'Pset_X', operator: 'exists' } }),
    ]);
    expect(notExistsEngine.getMatchingRules(element())).toHaveLength(1);
    expect(existsEngine.getMatchingRules(element())).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPOUND CRITERIA (and / or)
// ═══════════════════════════════════════════════════════════════════════════

describe('compound criteria', () => {
  it('and: requires every condition to match', () => {
    const criteria: OverrideCriteria = andCriteria(
      ifcTypeCriterion(['IfcWall'], false),
      propertyCriterion('Mark', 'equals', 'W1')
    );
    const engine = createOverrideEngine([rule({ criteria })]);

    expect(
      engine.getMatchingRules(
        element({ ifcType: 'IfcWall', properties: { P: { Mark: 'W1' } } })
      )
    ).toHaveLength(1);
    expect(
      engine.getMatchingRules(
        element({ ifcType: 'IfcWall', properties: { P: { Mark: 'W2' } } })
      )
    ).toHaveLength(0);
  });

  it('or: requires at least one condition to match', () => {
    const criteria: OverrideCriteria = orCriteria(
      ifcTypeCriterion(['IfcWall'], false),
      ifcTypeCriterion(['IfcSlab'], false)
    );
    const engine = createOverrideEngine([rule({ criteria })]);

    expect(engine.getMatchingRules(element({ ifcType: 'IfcWall' }))).toHaveLength(1);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcSlab' }))).toHaveLength(1);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcDoor' }))).toHaveLength(0);
  });

  it('nested compound criteria evaluate recursively', () => {
    const criteria: OverrideCriteria = andCriteria(
      ifcTypeCriterion(['IfcWall'], false),
      orCriteria(propertyCriterion('Mark', 'equals', 'W1'), propertyCriterion('Mark', 'equals', 'W2'))
    );
    const engine = createOverrideEngine([rule({ criteria })]);

    expect(
      engine.getMatchingRules(element({ ifcType: 'IfcWall', properties: { P: { Mark: 'W2' } } }))
    ).toHaveLength(1);
    expect(
      engine.getMatchingRules(element({ ifcType: 'IfcWall', properties: { P: { Mark: 'W3' } } }))
    ).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ABSENCE PATHS
// ═══════════════════════════════════════════════════════════════════════════

describe('absence paths', () => {
  it('no rules at all: resolves to the default style with no matched rules', () => {
    const engine = createOverrideEngine();
    const result = engine.applyOverrides(element());
    expect(result.matchedRules).toEqual([]);
    expect(result.style.fillColor).toBe('#CCCCCC');
    expect(result.style.visible).toBe(true);
  });

  it('a disabled rule is skipped even though its criteria match', () => {
    const engine = createOverrideEngine([
      rule({ enabled: false, style: { strokeColor: '#ff0000' } }),
    ]);
    const result = engine.applyOverrides(element());
    expect(result.matchedRules).toEqual([]);
    expect(result.style.strokeColor).toBe('#000000'); // default, untouched
  });

  it('a malformed property criterion (no propertyName) fails to match rather than throwing', () => {
    const engine = createOverrideEngine([
      rule({ criteria: { type: 'property' } as OverrideCriterion }),
    ]);
    expect(engine.getMatchingRules(element())).toHaveLength(0);
  });

  it('an unrecognized criterion type does not match (default: false)', () => {
    const engine = createOverrideEngine([
      rule({ criteria: { type: 'bogus' } as unknown as OverrideCriterion }),
    ]);
    expect(engine.getMatchingRules(element())).toHaveLength(0);
  });

  it('PIN (surprising): an ifcType criterion with an empty ifcTypes list matches every element', () => {
    // This is the behaviour as implemented — an empty/absent ifcTypes list is
    // treated as "no restriction" and returns true for every element, i.e. it
    // silently matches everything rather than signalling "nothing to match".
    const engine = createOverrideEngine([
      rule({ criteria: { type: 'ifcType', ifcTypes: [] } }),
    ]);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcWall' }))).toHaveLength(1);
    expect(engine.getMatchingRules(element({ ifcType: 'IfcAnything' }))).toHaveLength(1);
  });

  it('removeRule removes a rule by id and it no longer applies', () => {
    const engine = new GraphicOverrideEngine([rule({ id: 'x' })]);
    engine.removeRule('x');
    expect(engine.getRules()).toEqual([]);
  });

  it('validateCriteria flags a property criterion missing propertyName', () => {
    const errors = GraphicOverrideEngine.validateCriteria({ type: 'property' } as OverrideCriterion);
    expect(errors).toContain('Property criterion requires propertyName');
  });

  it('validateCriteria flags an ifcType criterion missing ifcTypes', () => {
    const errors = GraphicOverrideEngine.validateCriteria({ type: 'ifcType' } as OverrideCriterion);
    expect(errors).toContain('IFC type criterion requires at least one type');
  });

  it('validateCriteria flags an empty compound condition list', () => {
    const errors = GraphicOverrideEngine.validateCriteria({ logic: 'and', conditions: [] });
    expect(errors).toContain('Compound criteria must have at least one condition');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STYLE RESOLUTION HELPERS (exercised via mergeStyle in applyOverrides)
// ═══════════════════════════════════════════════════════════════════════════

describe('style resolution', () => {
  it('resolves a lineWeight preset name to its mm value', () => {
    const engine = createOverrideEngine([rule({ style: { lineWeight: 'heavy' } })]);
    expect(engine.applyOverrides(element()).style.lineWeight).toBe(0.5);
  });

  it('passes through a numeric lineWeight unchanged', () => {
    const engine = createOverrideEngine([rule({ style: { lineWeight: 0.77 } })]);
    expect(engine.applyOverrides(element()).style.lineWeight).toBe(0.77);
  });

  it('resolves a lineStyle preset name to its dash array', () => {
    const engine = createOverrideEngine([rule({ style: { lineStyle: 'dashdot' } })]);
    expect(engine.applyOverrides(element()).style.dashPattern).toEqual([3, 1, 0.5, 1]);
  });

  it('resolves a custom dash pattern object over a preset object', () => {
    const engine = createOverrideEngine([
      rule({ style: { lineStyle: { custom: [9, 9], preset: 'dotted' } } }),
    ]);
    expect(engine.applyOverrides(element()).style.dashPattern).toEqual([9, 9]);
  });

  it('applyOverridesToMany keys results by expressId and applies per-element base styles', () => {
    const engine = createOverrideEngine([rule({ style: { strokeColor: '#123456' } })]);
    const results = engine.applyOverridesToMany([
      element({ expressId: 1 }),
      element({ expressId: 2 }),
    ]);
    expect(results.get(1)!.style.strokeColor).toBe('#123456');
    expect(results.get(2)!.style.strokeColor).toBe('#123456');
    expect(results.size).toBe(2);
  });
});
