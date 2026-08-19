/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-check: BUILT_IN_PRESETS (presets.ts) is data driving the rule
 * engine (rule-engine.ts). rule-engine.ts got 46 tests for its own
 * evaluation logic; presets.ts, which supplies its input, has none. A
 * preset rule can look structurally valid (right shape, passes
 * GraphicOverrideEngine.validateCriteria) while its criteria are
 * unsatisfiable in practice — wrong IFC type spelling, an operator that
 * silently returns false for the value's type (e.g. numeric operators on
 * a non-number), a property name that never matches — so the rule always
 * falls into the engine's no-match branch and the preset silently does
 * nothing for the case it claims to handle. This is the same "two
 * structures over one domain, nothing compares them" shape as the
 * window-symbol mullion bug: the rule's criteria and the engine's
 * evaluator are two independent things that must agree, and only running
 * a rule's own criteria through the engine proves they do.
 *
 * For every rule in every built-in preset, this test:
 *  1. Validates the rule's criteria via GraphicOverrideEngine.validateCriteria
 *     (structural check, same as rule-engine's own tests).
 *  2. Synthesizes an ElementData designed to satisfy the rule's own
 *     criteria, and asserts the rule engine actually matches it — i.e.
 *     the rule is reachable, not a dead/no-op entry.
 */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_PRESETS } from './presets.js';
import { GraphicOverrideEngine } from './rule-engine.js';
import type {
  ElementData,
  GraphicOverrideRule,
  OverrideCriteria,
  OverrideCriterion,
} from './types.js';

function isCompound(
  c: OverrideCriteria | OverrideCriterion
): c is OverrideCriteria {
  return 'logic' in c && 'conditions' in c;
}

/**
 * Build an ElementData intended to satisfy the given criteria tree, by
 * reading the same fields the rule engine reads and constructing a value
 * that should make each leaf criterion evaluate true.
 */
function buildSatisfyingElement(
  criteria: OverrideCriteria | OverrideCriterion
): ElementData {
  const element: ElementData = {
    expressId: 1,
    ifcType: 'IfcBuildingElementProxy',
    properties: { Pset_Test: {} },
  };

  function apply(c: OverrideCriteria | OverrideCriterion): void {
    if (isCompound(c)) {
      // For OR compounds we only need one branch satisfied; satisfying
      // all is a superset and still valid for AND compounds too, except
      // where two leaves would conflict (not present in these presets).
      for (const cond of c.conditions) apply(cond);
      return;
    }

    switch (c.type) {
      case 'all':
        break;
      case 'ifcType':
        if (c.ifcTypes && c.ifcTypes.length > 0) {
          element.ifcType = c.ifcTypes[0];
        }
        break;
      case 'property': {
        if (!c.propertyName) break;
        const pset = c.propertySet ?? 'Pset_Test';
        element.properties = element.properties ?? {};
        element.properties[pset] = element.properties[pset] ?? {};
        const operator = c.operator ?? 'equals';
        let value: unknown;
        switch (operator) {
          case 'equals':
            value = c.value;
            break;
          case 'greaterOrEqual':
          case 'greaterThan':
            value = typeof c.value === 'number' ? c.value : 0;
            break;
          case 'lessOrEqual':
          case 'lessThan':
            value = typeof c.value === 'number' ? c.value : 0;
            break;
          case 'contains':
          case 'startsWith':
          case 'endsWith':
            value = typeof c.value === 'string' ? c.value : String(c.value ?? '');
            break;
          case 'exists':
            value = true;
            break;
          case 'in':
            value = Array.isArray(c.value) ? c.value[0] : c.value;
            break;
          default:
            value = c.value;
        }
        element.properties[pset][c.propertyName] = value;
        break;
      }
      case 'material':
        if (c.materialNames && c.materialNames.length > 0) {
          element.materials = [...(element.materials ?? []), c.materialNames[0]];
        }
        break;
      case 'layer':
        if (c.layerNames && c.layerNames.length > 0) {
          element.layers = [...(element.layers ?? []), c.layerNames[0]];
        }
        break;
      case 'expressId':
        if (c.expressIds && c.expressIds.length > 0) {
          element.expressId = c.expressIds[0];
        }
        break;
      case 'modelId':
        if (c.modelIds && c.modelIds.length > 0) {
          element.modelId = c.modelIds[0];
        }
        break;
    }
  }

  apply(criteria);
  return element;
}

describe('Built-in graphic-override presets are reachable through the engine', () => {
  for (const preset of BUILT_IN_PRESETS) {
    if (preset.rules.length === 0) {
      // e.g. VIEW_3D_PRESET intentionally ships zero rules — colors come
      // from mesh data directly, so there's nothing to cross-check.
      continue;
    }
    describe(`preset: ${preset.name} (${preset.id})`, () => {
      const engine = new GraphicOverrideEngine(preset.rules);

      for (const rule of preset.rules) {
        it(`rule "${rule.name}" validates and actually matches its own criteria`, () => {
          const errors = GraphicOverrideEngine.validateCriteria(rule.criteria);
          expect(errors, `validation errors for rule "${rule.name}"`).toEqual([]);

          const element = buildSatisfyingElement(rule.criteria);
          const matching = engine.getMatchingRules(element);
          const matchedIds = matching.map((r: GraphicOverrideRule) => r.id);

          expect(
            matchedIds,
            `rule "${rule.name}" (${rule.id}) did not match an element built to satisfy its own criteria: ${JSON.stringify(rule.criteria)} against element ${JSON.stringify(element)}`
          ).toContain(rule.id);
        });
      }
    });
  }
});
