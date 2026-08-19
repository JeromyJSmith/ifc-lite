/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the IFC-schema cross-check module, driven directly
 * against `runIfcSchemaAudit` with hand-built `IDSDocument` objects —
 * bypassing XML parsing entirely so each switch arm can be targeted
 * without depending on the XSD/structural layers.
 *
 * Real entity/pset/attribute/partOf rows are pulled from
 * `@ifc-lite/data`'s generated tables (grepped, not invented) so
 * assertions reflect the actual buildingSMART-derived schema data.
 */

import { describe, expect, it } from 'vitest';

import type {
  IDSAttributeFacet,
  IDSConstraint,
  IDSDocument,
  IDSEntityFacet,
  IDSFacet,
  IDSMaterialFacet,
  IDSPartOfFacet,
  IDSPropertyFacet,
  IDSRequirement,
  IDSSpecification,
  IFCVersion,
} from '../../types.js';
import type { IDSAuditCode, IDSAuditIssue } from '../types.js';
import { runIfcSchemaAudit } from './index.js';

function req(facet: IDSFacet, id = 'r0'): IDSRequirement {
  return { id, facet, optionality: 'required' };
}

function spec(overrides: {
  applicabilityFacets?: IDSFacet[];
  requirements?: IDSRequirement[];
  ifcVersions?: IFCVersion[];
}): IDSSpecification {
  return {
    id: 's0',
    name: 'Test spec',
    ifcVersions: overrides.ifcVersions ?? ['IFC4'],
    applicability: { facets: overrides.applicabilityFacets ?? [] },
    requirements: overrides.requirements ?? [],
  };
}

function doc(specs: IDSSpecification[]): IDSDocument {
  return { info: { title: 'Test' }, specifications: specs };
}

async function audit(
  s: IDSSpecification,
  version?: IFCVersion
): Promise<IDSAuditIssue[]> {
  return runIfcSchemaAudit(doc([s]), { ifcVersion: version });
}

function codes(issues: IDSAuditIssue[]): IDSAuditCode[] {
  return issues.map((i) => i.code);
}

const entityFacet = (name: string, predefinedType?: IDSConstraint): IDSEntityFacet => ({
  type: 'entity',
  name: { type: 'simpleValue', value: name },
  ...(predefinedType ? { predefinedType } : {}),
});

// ===========================================================================
// pickVersions / normaliseSchemaVersion switch (line ~94)
// ===========================================================================

describe('normaliseSchemaVersion (via pickVersions)', () => {
  it('normalises each of the four recognised IFCVersion literals', async () => {
    for (const v of ['IFC2X3', 'IFC4', 'IFC4X3', 'IFC4X3_ADD2'] as const) {
      const s = spec({
        applicabilityFacets: [entityFacet('IfcWall')],
        requirements: [req(entityFacet('IfcThisEntityDoesNotExist'))],
        ifcVersions: [v],
      });
      const issues = await audit(s);
      // The unknown entity name proves the version normalised to
      // something and the audit actually ran for it.
      expect(codes(issues)).toContain('E_IFC_ENTITY_UNKNOWN');
    }
  });

  it('skips a specification entirely when the ifcVersion override does not normalise', async () => {
    const s = spec({
      requirements: [req(entityFacet('IfcThisEntityDoesNotExist'))],
    });
    // Cast past the type system the same way a malformed/legacy caller
    // could — pickVersions must defend against this at runtime, not
    // just via the type checker.
    const issues = await audit(s, 'BOGUS_VERSION' as unknown as IFCVersion);
    expect(issues).toEqual([]);
  });

  it('dedupes an identical issue that fires for two versions declared on one spec, keeping the first version detail', async () => {
    const s = spec({
      requirements: [req(entityFacet('IfcThisEntityDoesNotExist'))],
      ifcVersions: ['IFC2X3', 'IFC4'],
    });
    const issues = await audit(s);
    const unknown = issues.filter((i) => i.code === 'E_IFC_ENTITY_UNKNOWN');
    expect(unknown).toHaveLength(1);
    expect((unknown[0].detail as { version: string }).version).toBe('IFC2X3');
  });
});

// ===========================================================================
// auditFacet switch on facet.type (line ~147) — one case per facet kind,
// dispatch proven by a distinguishing issue code from each branch.
// ===========================================================================

describe('auditFacet dispatch — one behaviour per facet.type', () => {
  it('entity facet dispatches to auditEntityFacet', async () => {
    const s = spec({
      requirements: [req(entityFacet('IfcNotARealEntity'))],
    });
    expect(codes(await audit(s))).toContain('E_IFC_ENTITY_UNKNOWN');
  });

  it('property facet dispatches to auditPropertyFacet', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_NotReal' },
      baseName: { type: 'simpleValue', value: 'X' },
    };
    // Not a reserved prefix, so no issue is expected here — instead prove
    // dispatch via the dataType branch, which always fires when set.
    const facetWithBadType: IDSPropertyFacet = {
      ...facet,
      dataType: { type: 'simpleValue', value: 'IfcNotARealDataType' },
    };
    expect(codes(await audit(spec({ requirements: [req(facetWithBadType)] })))).toContain(
      'E_IFC_DATATYPE_UNKNOWN'
    );
  });

  it('attribute facet dispatches to auditAttributeFacet', async () => {
    const applicability = entityFacet('IfcWall');
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: { type: 'simpleValue', value: 'NotARealAttribute' },
    };
    const s = spec({
      applicabilityFacets: [applicability],
      requirements: [req(facet)],
    });
    expect(codes(await audit(s))).toContain('E_IFC_ATTR_UNKNOWN_FOR_ENTITY');
  });

  it('partOf facet dispatches to auditPartOfFacet', async () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelAggregates',
      rawRelation: 'NotARealRelation',
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toContain(
      'E_IFC_PARTOF_RELATION'
    );
  });

  it('classification facet dispatches to auditClassificationFacet', async () => {
    // IfcCurve is not a subtype of IfcObjectDefinition (IFC4) — cannot be
    // classified.
    const s = spec({
      applicabilityFacets: [entityFacet('IfcCurve')],
      requirements: [req({ type: 'classification' })],
    });
    expect(codes(await audit(s))).toContain('E_IFC_PARTOF_ENTITY');
  });

  it('material facet dispatches to auditMaterialFacet', async () => {
    const facet: IDSMaterialFacet = { type: 'material' };
    const s = spec({
      applicabilityFacets: [entityFacet('IfcCurve')],
      requirements: [req(facet)],
    });
    expect(codes(await audit(s))).toContain('E_IFC_PARTOF_ENTITY');
  });
});

// ===========================================================================
// checkPredefinedType switch on c.type (line ~285)
// ===========================================================================

describe('checkPredefinedType — one arm per constraint type', () => {
  // IfcWall predefinedTypes (IFC4): MOVABLE, PARAPET, PARTITIONING,
  // PLUMBINGWALL, SHEAR, SOLIDWALL, STANDARD, POLYGONAL, ELEMENTEDWALL,
  // USERDEFINED, NOTDEFINED.
  it('simpleValue: flags a predefined type value not in the entity list', async () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'simpleValue', value: 'IfcWall' },
      predefinedType: { type: 'simpleValue', value: 'BOGUS' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toContain(
      'E_IFC_PREDEF_TYPE_INVALID'
    );
  });

  it('simpleValue: does not flag a valid predefined type', async () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'simpleValue', value: 'IfcWall' },
      predefinedType: { type: 'simpleValue', value: 'STANDARD' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_IFC_PREDEF_TYPE_INVALID'
    );
  });

  it('enumeration: flags any invalid value among the enumeration', async () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'simpleValue', value: 'IfcWall' },
      predefinedType: {
        type: 'enumeration',
        values: ['STANDARD', 'BOGUS'],
      },
    };
    const issues = (await audit(spec({ requirements: [req(facet)] }))).filter(
      (i) => i.code === 'E_IFC_PREDEF_TYPE_INVALID'
    );
    expect(issues).toHaveLength(1);
    expect((issues[0].detail as { value: string }).value).toBe('BOGUS');
  });

  it('enumeration: no issue when every value is valid', async () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'simpleValue', value: 'IfcWall' },
      predefinedType: {
        type: 'enumeration',
        values: ['STANDARD', 'PARAPET'],
      },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_IFC_PREDEF_TYPE_INVALID'
    );
  });

  it('pattern: flags a pattern that matches none of the entity predefined types', async () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'simpleValue', value: 'IfcWall' },
      predefinedType: { type: 'pattern', pattern: 'ZZZZZ.*' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toContain(
      'E_IFC_PREDEF_TYPE_INVALID'
    );
  });

  it('pattern: no issue when the pattern matches at least one predefined type', async () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'simpleValue', value: 'IfcWall' },
      predefinedType: { type: 'pattern', pattern: 'STAN.*' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_IFC_PREDEF_TYPE_INVALID'
    );
  });

  it('pattern: an uncompilable regex is silently skipped, not flagged', async () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'simpleValue', value: 'IfcWall' },
      predefinedType: { type: 'pattern', pattern: '[' }, // invalid regex
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_IFC_PREDEF_TYPE_INVALID'
    );
  });

  it('bounds: never flagged regardless of content (documented no-op arm)', async () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'simpleValue', value: 'IfcWall' },
      predefinedType: { type: 'bounds', minInclusive: 0, maxInclusive: 1 },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_IFC_PREDEF_TYPE_INVALID'
    );
  });
});

// ===========================================================================
// resolveEntityCandidates switch on facet.name.type (line ~713) — reached
// through the property-facet applicability cross-check
// (E_IFC_PROP_NOT_IN_PSET on `.propertySet`).
// ===========================================================================

describe('resolveEntityCandidates — one arm per name-constraint type', () => {
  // Pset_ManufacturerTypeInformation.applicableEntities = ["IfcElement"].
  // IfcCurve is not a subtype of IfcElement, so any entity resolved to
  // IfcCurve should trip E_IFC_PROP_NOT_IN_PSET when the pset is
  // Pset_ManufacturerTypeInformation.
  const propertyFacet: IDSPropertyFacet = {
    type: 'property',
    propertySet: {
      type: 'simpleValue',
      value: 'Pset_ManufacturerTypeInformation',
    },
    baseName: { type: 'simpleValue', value: 'Manufacturer' },
  };

  it('simpleValue: resolves to the single named entity', async () => {
    const s = spec({
      applicabilityFacets: [entityFacet('IfcCurve')],
      requirements: [req(propertyFacet)],
    });
    const issues = (await audit(s)).filter(
      (i) => i.code === 'E_IFC_PROP_NOT_IN_PSET' && i.path.endsWith('.propertySet')
    );
    expect(issues).toHaveLength(1);
    expect((issues[0].detail as { entity: string }).entity).toBe('IfcCurve');
  });

  it('enumeration: resolves to every listed value', async () => {
    const applicability: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'enumeration', values: ['IfcCurve', 'IfcGroup'] },
    };
    const s = spec({
      applicabilityFacets: [applicability],
      requirements: [req(propertyFacet)],
    });
    const issues = (await audit(s)).filter(
      (i) => i.code === 'E_IFC_PROP_NOT_IN_PSET' && i.path.endsWith('.propertySet')
    );
    expect(issues).toHaveLength(1);
    // Both candidates fail (neither is an IfcElement subtype), and the
    // label groups them.
    expect((issues[0].detail as { entity: string }).entity).toBe(
      '{IfcCurve, IfcGroup}'
    );
  });

  it('pattern: resolves candidates by matching entity names in the schema', async () => {
    const applicability: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'pattern', pattern: 'IfcCurve' },
    };
    const s = spec({
      applicabilityFacets: [applicability],
      requirements: [req(propertyFacet)],
    });
    const issues = (await audit(s)).filter(
      (i) => i.code === 'E_IFC_PROP_NOT_IN_PSET' && i.path.endsWith('.propertySet')
    );
    expect(issues).toHaveLength(1);
    expect((issues[0].detail as { entity: string }).entity).toBe('IfcCurve');
  });

  it('bounds (default arm): resolves to no candidates, so the applicability cross-check is silently skipped', async () => {
    const applicability: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'bounds', minInclusive: 0, maxInclusive: 1 },
    };
    const s = spec({
      applicabilityFacets: [applicability],
      requirements: [req(propertyFacet)],
    });
    const issues = (await audit(s)).filter(
      (i) => i.code === 'E_IFC_PROP_NOT_IN_PSET' && i.path.endsWith('.propertySet')
    );
    expect(issues).toHaveLength(0);
  });
});

// ===========================================================================
// checkRestrictionBase — outer early-return for simpleValue, then the
// inner switch on c.type (line ~555): pattern / enumeration / bounds.
// Reached via a property facet's @dataType + <value> restriction.
// ===========================================================================

describe('checkRestrictionBase', () => {
  // IFCLABEL backs to xs:string.
  const dataTypeFacetWith = (value: IDSConstraint): IDSPropertyFacet => ({
    type: 'property',
    propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
    baseName: { type: 'simpleValue', value: 'Manufacturer' },
    dataType: { type: 'simpleValue', value: 'IfcLabel' },
    value,
  });

  it('simpleValue <value>: never flagged (outer early return)', async () => {
    const facet = dataTypeFacetWith({ type: 'simpleValue', value: 'anything' });
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_RESTRICTION_BASE_MISMATCH'
    );
  });

  it('pattern with explicit @base: uses the declared base directly, flags xs:integer against IFCLABEL (xs:string)', async () => {
    const facet = dataTypeFacetWith({
      type: 'pattern',
      pattern: '.*',
      base: 'xs:integer',
    });
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toContain(
      'E_RESTRICTION_BASE_MISMATCH'
    );
  });

  it('pattern without @base: infers xs:string, so no mismatch against IFCLABEL', async () => {
    const facet = dataTypeFacetWith({ type: 'pattern', pattern: '.*' });
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_RESTRICTION_BASE_MISMATCH'
    );
  });

  it('enumeration without @base: infers xs:string, so no mismatch against IFCLABEL', async () => {
    const facet = dataTypeFacetWith({ type: 'enumeration', values: ['A', 'B'] });
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_RESTRICTION_BASE_MISMATCH'
    );
  });

  it('enumeration without @base against a numeric dataType (IfcReal, xs:double): flags the inferred xs:string mismatch', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'Manufacturer' },
      dataType: { type: 'simpleValue', value: 'IfcReal' },
      value: { type: 'enumeration', values: ['1', '2'] },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toContain(
      'E_RESTRICTION_BASE_MISMATCH'
    );
  });

  it('bounds with a length facet (minLength): infers xs:string, flags against a numeric dataType', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'Manufacturer' },
      dataType: { type: 'simpleValue', value: 'IfcReal' },
      value: { type: 'bounds', minLength: 1 },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toContain(
      'E_RESTRICTION_BASE_MISMATCH'
    );
  });

  it('bounds without a length facet (numeric range): infers xs:double, no mismatch against IfcReal', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'Manufacturer' },
      dataType: { type: 'simpleValue', value: 'IfcReal' },
      value: { type: 'bounds', minInclusive: 0, maxInclusive: 100 },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_RESTRICTION_BASE_MISMATCH'
    );
  });

  it('bounds without a length facet against IFCLABEL (xs:string): flags the inferred xs:double mismatch', async () => {
    const facet = dataTypeFacetWith({ type: 'bounds', minInclusive: 0, maxInclusive: 100 });
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toContain(
      'E_RESTRICTION_BASE_MISMATCH'
    );
  });

  it('the xs:double/xs:decimal/xs:float family is treated as mutually compatible', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'Manufacturer' },
      dataType: { type: 'simpleValue', value: 'IfcReal' }, // backs to xs:double
      value: { type: 'pattern', pattern: '.*', base: 'xs:decimal' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_RESTRICTION_BASE_MISMATCH'
    );
  });

  it('xs:integer is NOT promoted into the float family against an IFCREAL (xs:double) dataType', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'Manufacturer' },
      dataType: { type: 'simpleValue', value: 'IfcReal' },
      value: { type: 'pattern', pattern: '.*', base: 'xs:integer' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toContain(
      'E_RESTRICTION_BASE_MISMATCH'
    );
  });
});

// ===========================================================================
// checkDataTypeMatch + idsTemplateForKind switch on prop.kind (line ~604)
// ===========================================================================

describe('checkDataTypeMatch / idsTemplateForKind', () => {
  it('single: matches its own IFC dataType (Manufacturer -> IfcLabel)', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'Manufacturer' },
      dataType: { type: 'simpleValue', value: 'IfcLabel' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'W_IFC_DATATYPE_MISMATCH'
    );
  });

  it('single: also accepts the canonical IDS template token IFCPROPERTYSINGLEVALUE', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'Manufacturer' },
      dataType: { type: 'simpleValue', value: 'IFCPROPERTYSINGLEVALUE' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'W_IFC_DATATYPE_MISMATCH'
    );
  });

  it('single: flags a genuinely wrong dataType', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'Manufacturer' },
      dataType: { type: 'simpleValue', value: 'IfcReal' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toContain(
      'W_IFC_DATATYPE_MISMATCH'
    );
  });

  it('enumeration: PEnum_-shaped properties have no backing dataType and default to IfcLabel', async () => {
    // Pset_ManufacturerTypeInformation.AssemblyPlace is kind=enumeration.
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'AssemblyPlace' },
      dataType: { type: 'simpleValue', value: 'IfcLabel' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'W_IFC_DATATYPE_MISMATCH'
    );
  });

  it('enumeration: also accepts the canonical IDS template token IFCPROPERTYENUMERATEDVALUE', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'AssemblyPlace' },
      dataType: { type: 'simpleValue', value: 'IFCPROPERTYENUMERATEDVALUE' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'W_IFC_DATATYPE_MISMATCH'
    );
  });

  it('enumeration: flags a wrong dataType (not IfcLabel, not the template token)', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'AssemblyPlace' },
      dataType: { type: 'simpleValue', value: 'IfcReal' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toContain(
      'W_IFC_DATATYPE_MISMATCH'
    );
  });

  it("SURPRISING — kind='unknown' properties (no dataType, not enumeration) silently accept ANY declared dataType, even an obviously wrong one", async () => {
    // Pset_AirTerminalPHistory.CenterlineAirVelocity is kind=unknown in
    // IFC2X3 (real generated row — grepped from psets-ifc2x3.ts), applicable
    // to IfcPerformanceHistory. checkDataTypeMatch's `expected` resolves to
    // undefined for this shape (prop.dataType is unset and kind !== 'enumeration'),
    // so the function returns before comparing at all — no matter what @dataType
    // the IDS spec declares. This mirrors the module's own comment ("skip
    // rather than guess") but means kind='unknown' properties get ZERO
    // dataType validation, silently passing a mismatched declaration.
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_AirTerminalPHistory' },
      baseName: { type: 'simpleValue', value: 'CenterlineAirVelocity' },
      dataType: { type: 'simpleValue', value: 'ThisIsNotEvenAValidIfcDataTypeAtAll' },
    };
    const s = spec({
      requirements: [req(facet)],
      ifcVersions: ['IFC2X3'],
    });
    const issues = await audit(s);
    expect(codes(issues)).not.toContain('W_IFC_DATATYPE_MISMATCH');
    // The property itself is still confirmed present in the pset (the
    // "not part of pset" branch does not fire) — this is purely a
    // dataType-comparison gap, not a missing-property gap.
    expect(codes(issues)).not.toContain('E_IFC_PROP_NOT_IN_PSET');
  });
});

// ===========================================================================
// auditPropertyFacet — reserved-prefix / applicability / property-lookup
// branches not already covered above.
// ===========================================================================

describe('auditPropertyFacet — pset lookup and reserved-prefix branches', () => {
  it('unknown pset with a Pset_ prefix: warns W_IFC_PSET_RESERVED_PREFIX', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_TotallyMadeUp' },
      baseName: { type: 'simpleValue', value: 'X' },
    };
    const issues = await audit(spec({ requirements: [req(facet)] }));
    expect(codes(issues)).toContain('W_IFC_PSET_RESERVED_PREFIX');
    expect(issues.find((i) => i.code === 'W_IFC_PSET_RESERVED_PREFIX')?.severity).toBe(
      'warning'
    );
  });

  it('unknown pset WITHOUT a reserved prefix: silent (no issue at all)', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'MyCustomPset' },
      baseName: { type: 'simpleValue', value: 'X' },
    };
    expect(await audit(spec({ requirements: [req(facet)] }))).toEqual([]);
  });

  it('unknown Qto_ pset for IFC4 (no quantity-set coverage) is NOT flagged — canVerifyReservedSet honesty guard', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Qto_TotallyMadeUp' },
      baseName: { type: 'simpleValue', value: 'X' },
    };
    const s = spec({ requirements: [req(facet)], ifcVersions: ['IFC4'] });
    expect(codes(await audit(s))).not.toContain('W_IFC_PSET_RESERVED_PREFIX');
  });

  it('property that exists in the pset: no E_IFC_PROP_NOT_IN_PSET', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'Manufacturer' },
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_IFC_PROP_NOT_IN_PSET'
    );
  });

  it('property that does not exist in a known pset: E_IFC_PROP_NOT_IN_PSET on .baseName', async () => {
    const facet: IDSPropertyFacet = {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_ManufacturerTypeInformation' },
      baseName: { type: 'simpleValue', value: 'NotARealProperty' },
    };
    const issues = (await audit(spec({ requirements: [req(facet)] }))).filter(
      (i) => i.code === 'E_IFC_PROP_NOT_IN_PSET'
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toMatch(/\.baseName$/);
  });

  it('companion-type expansion: a type-entity applicability matches a pset whose applicableEntities lists only the occurrence class (#1441)', async () => {
    // Pset_ManufacturerTypeInformation.applicableEntities = ["IfcElement"].
    // IfcActuatorType's occurrence side (IfcActuator -> IfcDistributionControlElement
    // -> ... -> IfcElement) makes IfcActuatorType a companion type of an
    // IfcElement subtype via IfcActuator's typeEntity link. Confirm no
    // false-positive E_IFC_PROP_NOT_IN_PSET on .propertySet.
    const s = spec({
      applicabilityFacets: [entityFacet('IfcActuatorType')],
      requirements: [
        req({
          type: 'property',
          propertySet: {
            type: 'simpleValue',
            value: 'Pset_ManufacturerTypeInformation',
          },
          baseName: { type: 'simpleValue', value: 'Manufacturer' },
        }),
      ],
    });
    const issues = (await audit(s)).filter(
      (i) => i.code === 'E_IFC_PROP_NOT_IN_PSET' && i.path.endsWith('.propertySet')
    );
    expect(issues).toHaveLength(0);
  });
});

// ===========================================================================
// auditAttributeFacet — value-constraint branch (Report 102)
// ===========================================================================

describe('auditAttributeFacet', () => {
  it('no applicability entity: cross-check is skipped entirely', async () => {
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: { type: 'simpleValue', value: 'AnythingAtAll' },
    };
    expect(await audit(spec({ requirements: [req(facet)] }))).toEqual([]);
  });

  it('known attribute on the entity: no issue', async () => {
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: { type: 'simpleValue', value: 'Name' },
    };
    const s = spec({
      applicabilityFacets: [entityFacet('IfcWall')],
      requirements: [req(facet)],
    });
    expect(codes(await audit(s))).not.toContain('E_IFC_ATTR_UNKNOWN_FOR_ENTITY');
  });

  it('a complex/entity-typed attribute (IfcTask.TaskTime) with a <value> constraint is flagged (Report 102)', async () => {
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: { type: 'simpleValue', value: 'TaskTime' },
      value: { type: 'simpleValue', value: 'anything' },
    };
    const s = spec({
      applicabilityFacets: [entityFacet('IfcTask')],
      requirements: [req(facet)],
    });
    const issues = (await audit(s)).filter(
      (i) => i.code === 'E_IFC_ATTR_UNKNOWN_FOR_ENTITY'
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toMatch(/\.value$/);
  });

  it('the same complex attribute WITHOUT a <value> constraint is not flagged', async () => {
    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: { type: 'simpleValue', value: 'TaskTime' },
    };
    const s = spec({
      applicabilityFacets: [entityFacet('IfcTask')],
      requirements: [req(facet)],
    });
    expect(codes(await audit(s))).not.toContain('E_IFC_ATTR_UNKNOWN_FOR_ENTITY');
  });
});

// ===========================================================================
// auditPartOfFacet — relation lookup, entity/owner subtype check, member
// subtype check.
// ===========================================================================

describe('auditPartOfFacet', () => {
  it('a valid relation with no @entity/@applicability constraint: no issue', async () => {
    const facet: IDSPartOfFacet = { type: 'partOf', relation: 'IfcRelAggregates' };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).toEqual([]);
  });

  it('partOf @entity that is not a known IFC entity: E_IFC_PARTOF_ENTITY on .entity.name', async () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelAggregates',
      entity: entityFacet('IfcNotReal'),
    };
    const issues = (await audit(spec({ requirements: [req(facet)] }))).filter(
      (i) => i.code === 'E_IFC_PARTOF_ENTITY'
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toMatch(/\.entity\.name$/);
  });

  it('partOf @entity not a subtype of the relation owner: flagged', async () => {
    // IFCRELCONTAINEDINSPATIALSTRUCTURE owner = IFCSPATIALELEMENT (IFC4).
    // IfcWall is not a subtype of IfcSpatialElement.
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelContainedInSpatialStructure',
      entity: entityFacet('IfcWall'),
    };
    const issues = (await audit(spec({ requirements: [req(facet)] }))).filter(
      (i) => i.code === 'E_IFC_PARTOF_ENTITY'
    );
    expect(issues).toHaveLength(1);
  });

  it('partOf @entity that IS a subtype of the relation owner: no issue', async () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelContainedInSpatialStructure',
      entity: entityFacet('IfcSite'), // IfcSite is a subtype of IfcSpatialElement
    };
    expect(codes(await audit(spec({ requirements: [req(facet)] })))).not.toContain(
      'E_IFC_PARTOF_ENTITY'
    );
  });

  it('applicability entity not a subtype of the relation member: flagged with the relation.member requirement', async () => {
    // IFCRELCONTAINEDINSPATIALSTRUCTURE member = IFCPRODUCT (IFC4).
    // IfcOwnerHistory is not an IfcProduct.
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelContainedInSpatialStructure',
    };
    const s = spec({
      applicabilityFacets: [entityFacet('IfcOwnerHistory')],
      requirements: [req(facet)],
    });
    const issues = (await audit(s)).filter((i) => i.code === 'E_IFC_PARTOF_ENTITY');
    expect(issues).toHaveLength(1);
    expect((issues[0].detail as { required: string }).required).toBe('IFCPRODUCT');
  });

  it('applicability entity that IS a subtype of the relation member: no issue', async () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelContainedInSpatialStructure',
    };
    const s = spec({
      applicabilityFacets: [entityFacet('IfcWall')], // IfcWall -> IfcProduct
      requirements: [req(facet)],
    });
    expect(codes(await audit(s))).not.toContain('E_IFC_PARTOF_ENTITY');
  });

  it('rawRelation is preferred over the normalised relation for the bogus-input check', async () => {
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelAggregates', // normalised fallback
      rawRelation: 'IfcRelSomethingMadeUp',
    };
    const issues = (await audit(spec({ requirements: [req(facet)] }))).filter(
      (i) => i.code === 'E_IFC_PARTOF_RELATION'
    );
    expect(issues).toHaveLength(1);
    expect((issues[0].detail as { value: string }).value).toBe(
      'IfcRelSomethingMadeUp'
    );
  });
});

// ===========================================================================
// auditClassificationFacet / auditMaterialFacet — version-dependent
// expected supertype (IfcRoot for IFC2X3, IfcObjectDefinition otherwise).
// ===========================================================================

describe('auditClassificationFacet / auditMaterialFacet — version-dependent expected supertype', () => {
  it('classification: IFC2X3 uses IfcRoot as the required supertype', async () => {
    // IfcCurve is not a subtype of IfcRoot either, in IFC2X3.
    const s = spec({
      applicabilityFacets: [entityFacet('IfcCurve')],
      requirements: [req({ type: 'classification' })],
      ifcVersions: ['IFC2X3'],
    });
    const issues = (await audit(s)).filter((i) => i.code === 'E_IFC_PARTOF_ENTITY');
    expect(issues).toHaveLength(1);
    expect((issues[0].detail as { required: string }).required).toBe('IfcRoot');
  });

  it('classification: IFC4/IFC4X3 use IfcObjectDefinition as the required supertype', async () => {
    const s = spec({
      applicabilityFacets: [entityFacet('IfcCurve')],
      requirements: [req({ type: 'classification' })],
      ifcVersions: ['IFC4'],
    });
    const issues = (await audit(s)).filter((i) => i.code === 'E_IFC_PARTOF_ENTITY');
    expect(issues).toHaveLength(1);
    expect((issues[0].detail as { required: string }).required).toBe(
      'IfcObjectDefinition'
    );
  });

  it('classification: a proper IfcObjectDefinition subtype passes for IFC4', async () => {
    const s = spec({
      applicabilityFacets: [entityFacet('IfcWall')],
      requirements: [req({ type: 'classification' })],
      ifcVersions: ['IFC4'],
    });
    expect(codes(await audit(s))).not.toContain('E_IFC_PARTOF_ENTITY');
  });

  it('material: a non-IfcRoot entity in IFC2X3 is flagged', async () => {
    const s = spec({
      applicabilityFacets: [entityFacet('IfcCurve')],
      requirements: [req({ type: 'material' })],
      ifcVersions: ['IFC2X3'],
    });
    const issues = (await audit(s)).filter((i) => i.code === 'E_IFC_PARTOF_ENTITY');
    expect(issues).toHaveLength(1);
  });

  it('material: no applicability entity means the check is skipped entirely', async () => {
    expect(
      await audit(spec({ requirements: [req({ type: 'material' })] }))
    ).toEqual([]);
  });

  it('classification/material: an applicability entity whose name is not a simpleValue skips the check', async () => {
    const s = spec({
      applicabilityFacets: [
        { type: 'entity', name: { type: 'enumeration', values: ['IfcCurve'] } },
      ],
      requirements: [req({ type: 'classification' })],
      ifcVersions: ['IFC2X3'],
    });
    expect(await audit(s)).toEqual([]);
  });
});

// ===========================================================================
// auditEntityFacet — non-simpleValue name skip, unknown entity.
// ===========================================================================

describe('auditEntityFacet', () => {
  it('a pattern/enumeration/bounds name constraint skips the entity cross-check entirely (documented: resolving every match is out of scope)', async () => {
    const facet: IDSEntityFacet = {
      type: 'entity',
      name: { type: 'pattern', pattern: 'IFC.*' },
      predefinedType: { type: 'simpleValue', value: 'BOGUS' },
    };
    expect(await audit(spec({ requirements: [req(facet)] }))).toEqual([]);
  });

  it('a known entity name is not flagged', async () => {
    expect(
      await audit(spec({ requirements: [req(entityFacet('IfcWall'))] }))
    ).toEqual([]);
  });
});
