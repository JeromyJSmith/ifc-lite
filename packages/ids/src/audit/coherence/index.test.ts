/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import type {
  IDSConstraint,
  IDSDocument,
  IDSFacet,
  IDSRequirement,
  IDSSpecification,
} from '../../types.js';
import type { IDSAuditCode } from '../types.js';
import { runCoherenceAudit } from './index.js';

function codes(issues: { code: IDSAuditCode }[]): IDSAuditCode[] {
  return issues.map((i) => i.code);
}

const simpleValue = (value: string): IDSConstraint => ({
  type: 'simpleValue',
  value,
});

/** A minimal always-coherent entity facet, used as filler where the test
 * doesn't care about the applicability content. */
const wallFacet: IDSFacet = { type: 'entity', name: simpleValue('IFCWALL') };

function specWith(overrides: Partial<IDSSpecification>): IDSSpecification {
  return {
    id: 's1',
    name: 'Test spec',
    ifcVersions: ['IFC4'],
    applicability: { facets: [wallFacet] },
    requirements: [],
    ...overrides,
  };
}

function requirementSpec(req: Partial<IDSRequirement> & { facet: IDSFacet }): IDSSpecification {
  return specWith({
    requirements: [
      {
        id: 'r1',
        optionality: 'required',
        ...req,
      },
    ],
  });
}

function auditSpecs(...specs: IDSSpecification[]) {
  const doc: IDSDocument = { info: { title: 'T' }, specifications: specs };
  return runCoherenceAudit(doc);
}

describe('runCoherenceAudit — spec-level minOccurs/maxOccurs sanity', () => {
  it('flags a negative minOccurs', () => {
    const issues = auditSpecs(specWith({ minOccurs: -1 }));
    expect(codes(issues)).toContain('E_CARDINALITY_INVALID');
    expect(issues[0].path).toBe('specifications[0].minOccurs');
  });

  it('flags a non-integer minOccurs', () => {
    const issues = auditSpecs(specWith({ minOccurs: 1.5 }));
    expect(codes(issues)).toContain('E_CARDINALITY_INVALID');
  });

  it('flags a negative maxOccurs', () => {
    const issues = auditSpecs(specWith({ maxOccurs: -2 }));
    expect(codes(issues)).toContain('E_CARDINALITY_INVALID');
    expect(issues[0].path).toBe('specifications[0].maxOccurs');
  });

  it('flags a non-integer maxOccurs', () => {
    const issues = auditSpecs(specWith({ maxOccurs: 2.5 }));
    expect(codes(issues)).toContain('E_CARDINALITY_INVALID');
  });

  it('accepts maxOccurs="unbounded" without flagging it as non-integer', () => {
    const issues = auditSpecs(specWith({ minOccurs: 0, maxOccurs: 'unbounded' }));
    expect(codes(issues)).not.toContain('E_CARDINALITY_INVALID');
  });

  it('accepts minOccurs <= maxOccurs', () => {
    const issues = auditSpecs(specWith({ minOccurs: 1, maxOccurs: 3 }));
    expect(codes(issues)).not.toContain('E_CARDINALITY_INVALID');
  });
});

describe('runCoherenceAudit — cardinality on <applicability> (Report 202)', () => {
  it('flags cardinality set on the applicability block', () => {
    const spec = specWith({
      applicability: { facets: [wallFacet], cardinality: 'optional' },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('W_CARDINALITY_PROHIBITED_APPLICABILITY');
    const issue = issues.find(
      (i) => i.code === 'W_CARDINALITY_PROHIBITED_APPLICABILITY'
    )!;
    expect(issue.severity).toBe('warning');
    expect(issue.path).toBe('specifications[0].applicability.cardinality');
  });

  it('does not flag an applicability block with no cardinality attribute', () => {
    const spec = specWith({ applicability: { facets: [wallFacet] } });
    const issues = auditSpecs(spec);
    expect(codes(issues)).not.toContain('W_CARDINALITY_PROHIBITED_APPLICABILITY');
  });
});

describe('runCoherenceAudit — requirement @cardinality raw-value check', () => {
  it('flags a cardinalityRaw that did not normalise to a canonical value', () => {
    const spec = requirementSpec({
      cardinalityRaw: 'Sometimes',
      facet: { type: 'attribute', name: simpleValue('Name') },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('E_CARDINALITY_INVALID');
    const issue = issues.find((i) => i.code === 'E_CARDINALITY_INVALID')!;
    expect(issue.facetType).toBe('attribute');
    expect(issue.detail).toEqual({ value: 'Sometimes' });
  });

  it('does not flag a requirement with no cardinalityRaw (canonical value)', () => {
    const spec = requirementSpec({
      facet: { type: 'attribute', name: simpleValue('Name') },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_CARDINALITY_INVALID');
  });
});

describe('runCoherenceAudit — <property> requirement cardinality', () => {
  it('flags optional <property> requirement missing @dataType', () => {
    const spec = requirementSpec({
      optionality: 'optional',
      facet: {
        type: 'property',
        propertySet: simpleValue('Pset_WallCommon'),
        baseName: simpleValue('IsExternal'),
      },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('E_CARDINALITY_INVALID');
    expect(
      issues.find((i) => i.code === 'E_CARDINALITY_INVALID')!.message
    ).toMatch(/requires @dataType/);
  });

  it('accepts optional <property> requirement that declares @dataType', () => {
    const spec = requirementSpec({
      optionality: 'optional',
      facet: {
        type: 'property',
        propertySet: simpleValue('Pset_WallCommon'),
        baseName: simpleValue('IsExternal'),
        dataType: simpleValue('IFCBOOLEAN'),
      },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_CARDINALITY_INVALID');
  });

  it('flags prohibited <property> requirement that still declares @dataType', () => {
    const spec = requirementSpec({
      optionality: 'prohibited',
      facet: {
        type: 'property',
        propertySet: simpleValue('Pset_WallCommon'),
        baseName: simpleValue('IsExternal'),
        dataType: simpleValue('IFCBOOLEAN'),
      },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('E_CARDINALITY_INVALID');
    expect(
      issues.find((i) => i.code === 'E_CARDINALITY_INVALID')!.message
    ).toMatch(/incompatible with @dataType/);
  });

  it('accepts prohibited <property> requirement without @dataType', () => {
    const spec = requirementSpec({
      optionality: 'prohibited',
      facet: {
        type: 'property',
        propertySet: simpleValue('Pset_WallCommon'),
        baseName: simpleValue('IsExternal'),
      },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_CARDINALITY_INVALID');
  });

  it('accepts a required <property> requirement without @dataType (rule only applies to optional)', () => {
    const spec = requirementSpec({
      optionality: 'required',
      facet: {
        type: 'property',
        propertySet: simpleValue('Pset_WallCommon'),
        baseName: simpleValue('IsExternal'),
      },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_CARDINALITY_INVALID');
  });
});

describe('runCoherenceAudit — <material> requirement cardinality', () => {
  it('flags optional <material> requirement with no value constraint at all', () => {
    const spec = requirementSpec({
      optionality: 'optional',
      facet: { type: 'material' },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('E_CARDINALITY_INVALID');
    expect(
      issues.find((i) => i.code === 'E_CARDINALITY_INVALID')!.message
    ).toMatch(/non-empty <value>/);
  });

  it('flags optional <material> requirement whose value constraint is empty', () => {
    const spec = requirementSpec({
      optionality: 'optional',
      facet: { type: 'material', value: { type: 'enumeration', values: [] } },
    });
    expect(codes(auditSpecs(spec))).toContain('E_CARDINALITY_INVALID');
  });

  it('accepts optional <material> requirement with a non-empty value constraint', () => {
    const spec = requirementSpec({
      optionality: 'optional',
      facet: { type: 'material', value: simpleValue('Concrete') },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_CARDINALITY_INVALID');
  });
});

describe('runCoherenceAudit — <classification> requirement cardinality', () => {
  it('flags optional <classification> requirement with neither system nor value', () => {
    const spec = requirementSpec({
      optionality: 'optional',
      facet: { type: 'classification' },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('E_CARDINALITY_INVALID');
    expect(
      issues.find((i) => i.code === 'E_CARDINALITY_INVALID')!.message
    ).toMatch(/<system> or <value>/);
  });

  it('accepts optional <classification> requirement with only a system constraint', () => {
    const spec = requirementSpec({
      optionality: 'optional',
      facet: { type: 'classification', system: simpleValue('Uniclass') },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_CARDINALITY_INVALID');
  });

  it('accepts optional <classification> requirement with only a value constraint', () => {
    const spec = requirementSpec({
      optionality: 'optional',
      facet: { type: 'classification', value: simpleValue('Ss_25_10_30') },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_CARDINALITY_INVALID');
  });
});

describe('runCoherenceAudit — <partOf> requirement cardinality (KNOWN GAP vs docstring)', () => {
  // The JSDoc above `auditRequirementCardinality` explicitly states:
  //   `cardinality="optional"` on `<material>`, `<classification>` and
  //   `<partOf>` requires a value/system/entity to be specified.
  // but the `switch (req.facet.type)` groups 'partOf' with 'attribute' and
  // 'entity' in the no-op default arm — only material/classification are
  // actually implemented. This pins the CURRENT (under-implemented)
  // behaviour so a future fix intentionally changes this test, rather than
  // silently regressing back to a no-op.
  it('does NOT flag an optional <partOf> requirement with no entity constraint, despite the docstring', () => {
    const spec = requirementSpec({
      optionality: 'optional',
      facet: { type: 'partOf', relation: 'IfcRelAggregates' },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_CARDINALITY_INVALID');
  });
});

describe('runCoherenceAudit — auditFacetConstraints per facet type', () => {
  it('checks an entity facet name constraint', () => {
    const spec = specWith({
      applicability: {
        facets: [{ type: 'entity', name: { type: 'enumeration', values: [] } }],
      },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('E_RESTRICTION_EMPTY');
    expect(issues[0].path).toBe('specifications[0].applicability.facets[0].name');
  });

  it('checks an entity facet predefinedType constraint when present', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'entity',
            name: simpleValue('IFCWALL'),
            predefinedType: { type: 'enumeration', values: [] },
          },
        ],
      },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('E_RESTRICTION_EMPTY');
    expect(issues[0].path).toBe(
      'specifications[0].applicability.facets[0].predefinedType'
    );
  });

  it('checks an attribute facet value constraint when present', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'attribute',
            name: simpleValue('Name'),
            value: { type: 'pattern', pattern: '(unclosed' },
          },
        ],
      },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('E_RESTRICTION_EMPTY');
    expect(issues[0].path).toBe('specifications[0].applicability.facets[0].value');
  });

  it('checks a property facet propertySet, baseName, dataType and value constraints', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'property',
            propertySet: { type: 'enumeration', values: [] },
            baseName: simpleValue('IsExternal'),
            dataType: simpleValue('IFCBOOLEAN'),
            value: { type: 'bounds' },
          },
        ],
      },
    });
    const issues = auditSpecs(spec);
    // propertySet enumeration is empty -> E_RESTRICTION_EMPTY
    // value bounds is empty (no facets set) -> E_RESTRICTION_EMPTY
    const empties = issues.filter((i) => i.code === 'E_RESTRICTION_EMPTY');
    expect(empties.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        'specifications[0].applicability.facets[0].propertySet',
        'specifications[0].applicability.facets[0].value',
      ])
    );
  });

  it('checks a classification facet system and value constraints', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'classification',
            system: { type: 'pattern', pattern: '' },
            value: { type: 'enumeration', values: [] },
          },
        ],
      },
    });
    const issues = auditSpecs(spec);
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('specifications[0].applicability.facets[0].system');
    expect(paths).toContain('specifications[0].applicability.facets[0].value');
  });

  it('checks a material facet value constraint', () => {
    const spec = specWith({
      applicability: {
        facets: [{ type: 'material', value: { type: 'enumeration', values: [] } }],
      },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('E_RESTRICTION_EMPTY');
    expect(issues[0].path).toBe('specifications[0].applicability.facets[0].value');
  });

  it('recurses into the nested entity of a partOf facet', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'partOf',
            relation: 'IfcRelAggregates',
            entity: { type: 'entity', name: { type: 'enumeration', values: [] } },
          },
        ],
      },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).toContain('E_RESTRICTION_EMPTY');
    expect(issues[0].path).toBe(
      'specifications[0].applicability.facets[0].entity.name'
    );
  });

  it('does not descend into a partOf facet with no nested entity', () => {
    const spec = specWith({
      applicability: { facets: [{ type: 'partOf', relation: 'IfcRelAggregates' }] },
    });
    expect(auditSpecs(spec)).toEqual([]);
  });
});

describe('runCoherenceAudit — xs:enumeration checks', () => {
  it('flags an enumeration with zero values as an error', () => {
    const spec = specWith({
      applicability: {
        facets: [{ type: 'entity', name: { type: 'enumeration', values: [] } }],
      },
    });
    const issue = auditSpecs(spec).find((i) => i.code === 'E_RESTRICTION_EMPTY')!;
    expect(issue.severity).toBe('error');
    expect(issue.message).toMatch(/at least one value/);
  });

  it('flags an enumeration with an empty-string entry as a warning (not an error)', () => {
    const spec = specWith({
      applicability: {
        facets: [
          { type: 'entity', name: { type: 'enumeration', values: ['IFCWALL', ''] } },
        ],
      },
    });
    const issue = auditSpecs(spec).find((i) => i.code === 'E_RESTRICTION_EMPTY')!;
    expect(issue.severity).toBe('warning');
    expect(issue.message).toMatch(/empty entry/);
  });

  it('does not flag a fully-populated enumeration', () => {
    const spec = specWith({
      applicability: {
        facets: [
          { type: 'entity', name: { type: 'enumeration', values: ['IFCWALL', 'IFCSLAB'] } },
        ],
      },
    });
    expect(auditSpecs(spec)).toEqual([]);
  });

  it('does not fabricate a value-mismatch error when the restriction base is unrecognised', () => {
    // `isValidLexicalForXsType` returns true (no error) for a base it
    // doesn't have a regex for — "don't fabricate errors" per its comment.
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'entity',
            name: { type: 'enumeration', values: ['anything at all'], base: 'xs:anyURI' },
          },
        ],
      },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_RESTRICTION_VALUE_MISMATCH');
  });

  it('flags an enumeration value invalid for xs:boolean', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'entity',
            name: { type: 'enumeration', values: ['true', 'yes'], base: 'xs:boolean' },
          },
        ],
      },
    });
    const issue = auditSpecs(spec).find(
      (i) => i.code === 'E_RESTRICTION_VALUE_MISMATCH'
    )!;
    expect(issue.detail).toEqual({ value: 'yes', base: 'xs:boolean' });
  });

  it('accepts valid xs:boolean enumeration values (true/false/0/1)', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'entity',
            name: { type: 'enumeration', values: ['true', 'false', '0', '1'], base: 'xs:boolean' },
          },
        ],
      },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_RESTRICTION_VALUE_MISMATCH');
  });

  it('flags an enumeration value invalid for xs:date', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'entity',
            name: { type: 'enumeration', values: ['2024-01-15', 'not-a-date'], base: 'xs:date' },
          },
        ],
      },
    });
    expect(codes(auditSpecs(spec))).toContain('E_RESTRICTION_VALUE_MISMATCH');
  });

  it('accepts a valid xs:date enumeration value', () => {
    const spec = specWith({
      applicability: {
        facets: [
          { type: 'entity', name: { type: 'enumeration', values: ['2024-01-15'], base: 'xs:date' } },
        ],
      },
    });
    expect(codes(auditSpecs(spec))).not.toContain('E_RESTRICTION_VALUE_MISMATCH');
  });

  it('skips null/empty enumeration values when checking lexical validity', () => {
    // The loop `if (v == null || v === '') continue;` — those are already
    // reported by the empty-entry warning above, not re-flagged here.
    const spec = specWith({
      applicability: {
        facets: [
          { type: 'entity', name: { type: 'enumeration', values: ['', '42'], base: 'xs:integer' } },
        ],
      },
    });
    const issues = auditSpecs(spec);
    expect(codes(issues)).not.toContain('E_RESTRICTION_VALUE_MISMATCH');
  });
});

describe('runCoherenceAudit — xs:restriction bounds checks', () => {
  it('flags inverted numeric bounds (min > max)', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'attribute',
            name: simpleValue('Name'),
            value: { type: 'bounds', minInclusive: 10, maxInclusive: 1 },
          },
        ],
      },
    });
    const issue = auditSpecs(spec).find((i) => i.code === 'E_RESTRICTION_RANGE')!;
    expect(issue.detail).toEqual({ min: 10, max: 1 });
  });

  it('flags inverted string lengths (minLength > maxLength)', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'attribute',
            name: simpleValue('Name'),
            value: { type: 'bounds', minLength: 10, maxLength: 3 },
          },
        ],
      },
    });
    const issues = auditSpecs(spec).filter((i) => i.code === 'E_RESTRICTION_RANGE');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/lengths inverted/);
    expect(issues[0].detail).toEqual({ min: 10, max: 3 });
  });

  it('warns when xs:length is combined with xs:minLength/xs:maxLength', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'attribute',
            name: simpleValue('Name'),
            value: { type: 'bounds', length: 5, minLength: 2 },
          },
        ],
      },
    });
    const issue = auditSpecs(spec).find(
      (i) => i.message === 'xs:length is mutually exclusive with xs:minLength/xs:maxLength'
    )!;
    expect(issue.severity).toBe('warning');
  });

  it('flags a bounds restriction with no facets set at all as empty', () => {
    const spec = specWith({
      applicability: {
        facets: [{ type: 'attribute', name: simpleValue('Name'), value: { type: 'bounds' } }],
      },
    });
    const issue = auditSpecs(spec).find((i) => i.code === 'E_RESTRICTION_EMPTY')!;
    expect(issue.message).toMatch(/no min\/max bounds or length facets/);
  });

  it('accepts a bounds restriction with a single populated facet', () => {
    const spec = specWith({
      applicability: {
        facets: [
          { type: 'attribute', name: simpleValue('Name'), value: { type: 'bounds', minLength: 1 } },
        ],
      },
    });
    expect(auditSpecs(spec)).toEqual([]);
  });
});

describe('runCoherenceAudit — xs:pattern checks', () => {
  it('flags an empty pattern as an error with a dedicated message', () => {
    const spec = specWith({
      applicability: {
        facets: [
          { type: 'attribute', name: simpleValue('Name'), value: { type: 'pattern', pattern: '' } },
        ],
      },
    });
    const issue = auditSpecs(spec).find((i) => i.code === 'E_RESTRICTION_EMPTY')!;
    expect(issue.message).toBe('xs:pattern @value is empty');
    expect(issue.detail).toBeUndefined();
  });

  it('flags an unparsable pattern as an error with the reason in detail', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'attribute',
            name: simpleValue('Name'),
            value: { type: 'pattern', pattern: '(unclosed' },
          },
        ],
      },
    });
    const issue = auditSpecs(spec).find((i) => i.code === 'E_RESTRICTION_EMPTY')!;
    expect(issue.detail).toEqual({ pattern: '(unclosed' });
  });

  it('warns (does not error) on XSD-only regex syntax the JS engine cannot verify', () => {
    const spec = specWith({
      applicability: {
        facets: [
          {
            type: 'classification',
            value: { type: 'pattern', pattern: '[a-z-[aeiou]]' },
          },
        ],
      },
    });
    const issue = auditSpecs(spec).find((i) => i.code === 'W_REGEX_UNVERIFIED')!;
    expect(issue.severity).toBe('warning');
    expect(issue.facetType).toBe('classification');
  });

  it('accepts a well-formed pattern', () => {
    const spec = specWith({
      applicability: {
        facets: [
          { type: 'attribute', name: simpleValue('Name'), value: { type: 'pattern', pattern: '[A-Z]+' } },
        ],
      },
    });
    expect(auditSpecs(spec)).toEqual([]);
  });
});

describe('runCoherenceAudit — simpleValue constraints are not coherence-checked', () => {
  it('never raises an issue for a simpleValue constraint, empty or not', () => {
    const spec = specWith({
      applicability: {
        facets: [{ type: 'attribute', name: simpleValue('Name'), value: simpleValue('') }],
      },
    });
    // Empty simpleValue is an XSD-required-attr concern, not coherence's.
    expect(auditSpecs(spec)).toEqual([]);
  });
});

describe('runCoherenceAudit — multiple specifications', () => {
  it('indexes issues by specification position', () => {
    const bad = specWith({ minOccurs: -1 });
    const good = specWith({});
    const issues = auditSpecs(good, bad);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('specifications[1].minOccurs');
  });

  it('returns an empty array for a document with no specifications', () => {
    const doc: IDSDocument = { info: { title: 'T' }, specifications: [] };
    expect(runCoherenceAudit(doc)).toEqual([]);
  });
});
