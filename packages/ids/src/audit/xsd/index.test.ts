/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import type {
  IDSConstraint,
  IDSDocument,
  IDSFacet,
  IDSSpecification,
  IFCVersion,
} from '../../types.js';
import type { IDSAuditCode } from '../types.js';
import { runXsdAudit } from './index.js';

function codes(issues: { code: IDSAuditCode }[]): IDSAuditCode[] {
  return issues.map((i) => i.code);
}

const simpleValue = (value: string): IDSConstraint => ({
  type: 'simpleValue',
  value,
});

const wallFacet: IDSFacet = { type: 'entity', name: simpleValue('IFCWALL') };
const nameReq: IDSFacet = { type: 'attribute', name: simpleValue('Name') };

function specWith(overrides: Partial<IDSSpecification>): IDSSpecification {
  return {
    id: 's1',
    name: 'Test spec',
    ifcVersions: ['IFC4'],
    applicability: { facets: [wallFacet] },
    requirements: [
      { id: 'r1', optionality: 'required', facet: nameReq },
    ],
    ...overrides,
  };
}

function auditDoc(doc: Partial<IDSDocument>): ReturnType<typeof runXsdAudit> {
  const full: IDSDocument = {
    info: { title: 'Test IDS' },
    specifications: [],
    ...doc,
  };
  return runXsdAudit(full);
}

function auditSpecs(...specs: IDSSpecification[]) {
  return auditDoc({ specifications: specs });
}

describe('runXsdAudit — xsi:schemaLocation (Report 107)', () => {
  it('accepts a recognised IDS schema URL', () => {
    const issues = auditDoc({
      schemaLocation:
        'http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd',
    });
    expect(codes(issues)).not.toContain('E_XSD_SCHEMA_LOCATION');
  });

  it('flags a schemaLocation that points at an unrecognised URL', () => {
    const issues = auditDoc({
      schemaLocation:
        'http://standards.buildingsmart.org/IDS http://example.com/not-ids.xsd',
    });
    expect(codes(issues)).toContain('E_XSD_SCHEMA_LOCATION');
    const issue = issues.find((i) => i.code === 'E_XSD_SCHEMA_LOCATION')!;
    expect(issue.detail).toEqual({ url: 'http://example.com/not-ids.xsd' });
  });

  it('ignores schemaLocation pairs for a different (non-IDS) namespace', () => {
    // Only the pair whose namespace token is the IDS namespace is checked;
    // an xsi:schemaLocation with other ns/url pairs (e.g. xsi itself, or an
    // unrelated schema) must not be flagged even if the URL looks bogus.
    const issues = auditDoc({
      schemaLocation: 'http://www.w3.org/2001/XMLSchema-instance http://totally-bogus.example/x.xsd',
    });
    expect(codes(issues)).not.toContain('E_XSD_SCHEMA_LOCATION');
  });

  it('does not check schemaLocation when absent', () => {
    expect(codes(auditDoc({}))).not.toContain('E_XSD_SCHEMA_LOCATION');
  });
});

describe('runXsdAudit — <info><title>', () => {
  it('warns when title is missing (empty string)', () => {
    const issues = auditDoc({ info: { title: '' } });
    const issue = issues.find((i) => i.code === 'E_XSD_REQUIRED_ATTR' && i.path === 'info.title')!;
    expect(issue.severity).toBe('warning');
  });

  it('warns when title is whitespace-only', () => {
    const issues = auditDoc({ info: { title: '   ' } });
    expect(
      issues.some((i) => i.code === 'E_XSD_REQUIRED_ATTR' && i.path === 'info.title')
    ).toBe(true);
  });

  it('warns when title is the placeholder "Untitled IDS"', () => {
    const issues = auditDoc({ info: { title: 'Untitled IDS' } });
    expect(
      issues.some((i) => i.code === 'E_XSD_REQUIRED_ATTR' && i.path === 'info.title')
    ).toBe(true);
  });

  it('does not warn on a real title', () => {
    const issues = auditDoc({ info: { title: 'Wall requirements' } });
    expect(issues.some((i) => i.path === 'info.title')).toBe(false);
  });
});

describe('runXsdAudit — specification @name', () => {
  it('flags a missing @name', () => {
    const issues = auditSpecs(specWith({ name: '' }));
    expect(
      issues.some((i) => i.code === 'E_XSD_REQUIRED_ATTR' && i.path === 'specifications[0].name')
    ).toBe(true);
  });

  it('flags a whitespace-only @name', () => {
    const issues = auditSpecs(specWith({ name: '   ' }));
    expect(issues.some((i) => i.path === 'specifications[0].name')).toBe(true);
  });

  it('flags the auto-generated placeholder name "Specification N"', () => {
    const issues = auditSpecs(specWith({ name: 'Specification 3' }));
    expect(
      issues.some((i) => i.code === 'E_XSD_REQUIRED_ATTR' && i.path === 'specifications[0].name')
    ).toBe(true);
  });

  it('does not flag a name that merely starts with the word "Specification"', () => {
    // The placeholder regex is anchored (`^Specification \d+$`) — a real
    // authored name using the same word must not false-positive.
    const issues = auditSpecs(specWith({ name: 'Specification for external walls' }));
    expect(issues.some((i) => i.path === 'specifications[0].name')).toBe(false);
  });

  it('accepts a normal name', () => {
    const issues = auditSpecs(specWith({ name: 'Walls must have a Name' }));
    expect(issues.some((i) => i.path === 'specifications[0].name')).toBe(false);
  });
});

describe('runXsdAudit — @ifcVersion', () => {
  it('flags a missing/empty ifcVersions list', () => {
    const issues = auditSpecs(specWith({ ifcVersions: [] }));
    expect(
      issues.some((i) => i.code === 'E_XSD_REQUIRED_ATTR' && i.path === 'specifications[0].ifcVersion')
    ).toBe(true);
  });

  it('flags every ifcVersions entry that is not in the allowed set', () => {
    const issues = auditSpecs(
      specWith({ ifcVersions: ['IFC2X3', 'IFC9000' as IFCVersion] })
    );
    const enumIssues = issues.filter((i) => i.code === 'E_XSD_ENUM');
    expect(enumIssues).toHaveLength(1);
    expect(enumIssues[0].detail).toEqual({ value: 'IFC9000' });
  });

  it('accepts every canonical IFC version value', () => {
    const versions: IFCVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3_ADD2', 'IFC4X3'];
    for (const v of versions) {
      const issues = auditSpecs(specWith({ ifcVersions: [v] }));
      expect(codes(issues)).not.toContain('E_XSD_ENUM');
    }
  });

  it('flags an unrecognised token in the raw ifcVersion attribute string', () => {
    const issues = auditSpecs(
      specWith({ ifcVersions: ['IFC4'], ifcVersionRaw: 'IFC4 INVALIDVERSION' })
    );
    const enumIssues = issues.filter((i) => i.code === 'E_XSD_ENUM');
    expect(enumIssues.some((i) => i.detail?.value === 'INVALIDVERSION')).toBe(true);
  });

  it('does not flag a raw ifcVersion token that normalises to a recognised version', () => {
    // isRecognisedIfcVersionToken uppercases and strips non [A-Z0-9_], so
    // lowercase / punctuated tokens that resolve to a canonical name pass.
    const issues = auditSpecs(
      specWith({ ifcVersions: ['IFC4X3_ADD2'], ifcVersionRaw: 'ifc4x3_add2' })
    );
    expect(codes(issues)).not.toContain('E_XSD_ENUM');
  });

  it('agrees with the ifcVersions-array enum check for every canonical token in ifcVersionRaw', () => {
    // Two structures over one domain: the array-based enum check and the
    // raw-token check must accept exactly the same canonical version set.
    const versions: IFCVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3_ADD2', 'IFC4X3'];
    for (const v of versions) {
      const issues = auditSpecs(specWith({ ifcVersions: [v], ifcVersionRaw: v }));
      expect(codes(issues)).not.toContain('E_XSD_ENUM');
    }
  });

  it('does not re-check raw tokens when ifcVersionRaw is absent', () => {
    const issues = auditSpecs(specWith({ ifcVersions: ['IFC4'] }));
    expect(codes(issues)).not.toContain('E_XSD_ENUM');
  });
});

describe('runXsdAudit — <applicability> structure', () => {
  it('flags an empty applicability (no facets)', () => {
    const issues = auditSpecs(specWith({ applicability: { facets: [] } }));
    expect(
      issues.some(
        (i) => i.code === 'E_XSD_STRUCTURE' && i.path === 'specifications[0].applicability'
      )
    ).toBe(true);
  });

  it('does not flag a non-empty applicability', () => {
    const issues = auditSpecs(specWith({ applicability: { facets: [wallFacet] } }));
    expect(
      issues.some((i) => i.path === 'specifications[0].applicability')
    ).toBe(false);
  });
});

describe('runXsdAudit — <requirements> structure (#1444)', () => {
  it('warns on a specification with no requirements and no explicit maxOccurs', () => {
    const issues = auditSpecs(specWith({ requirements: [] }));
    const issue = issues.find(
      (i) => i.code === 'E_XSD_STRUCTURE' && i.path === 'specifications[0].requirements'
    )!;
    expect(issue.severity).toBe('warning');
  });

  it('does not warn on an empty-requirements spec that declares a numeric maxOccurs (prohibited-spec idiom)', () => {
    const issues = auditSpecs(specWith({ requirements: [], maxOccurs: 0 }));
    expect(issues.some((i) => i.path === 'specifications[0].requirements')).toBe(false);
  });

  it('does not warn when requirements are present', () => {
    const issues = auditSpecs(specWith({}));
    expect(issues.some((i) => i.path === 'specifications[0].requirements')).toBe(false);
  });
});

describe('runXsdAudit — facet type gate', () => {
  it('flags a facet whose type is not one of the recognised applicability facets', () => {
    const bogus = { type: 'bogus' } as unknown as IDSFacet;
    const issues = auditSpecs(specWith({ applicability: { facets: [bogus] } }));
    const issue = issues.find(
      (i) => i.code === 'E_XSD_STRUCTURE' && i.path === 'specifications[0].applicability.facets[0]'
    )!;
    expect(issue.message).toBe('unknown facet type "bogus"');
  });

  it('does not run per-type required-attribute checks on an unrecognised facet type', () => {
    // The gate `return`s before the switch — an unknown facet type must
    // produce exactly one issue (the gate itself), not also attempt (and
    // possibly crash on, or double-report via) the per-type checks below it.
    const bogus = { type: 'bogus' } as unknown as IDSFacet;
    const issues = auditSpecs(specWith({ applicability: { facets: [bogus] } }));
    const structureIssues = issues.filter(
      (i) => i.path === 'specifications[0].applicability.facets[0]'
    );
    expect(structureIssues).toHaveLength(1);
  });
});

describe('runXsdAudit — per-facet required attributes', () => {
  it('requires entity.name', () => {
    const facet = { type: 'entity', name: undefined } as unknown as IDSFacet;
    const issues = auditSpecs(specWith({ applicability: { facets: [facet] } }));
    expect(
      issues.some((i) => i.code === 'E_XSD_REQUIRED_ATTR' && i.message === 'entity.name is required')
    ).toBe(true);
  });

  it('requires attribute.name', () => {
    const facet = { type: 'attribute', name: undefined } as unknown as IDSFacet;
    const issues = auditSpecs(specWith({ requirements: [{ id: 'r1', optionality: 'required', facet }] }));
    expect(
      issues.some((i) => i.code === 'E_XSD_REQUIRED_ATTR' && i.message === 'attribute.name is required')
    ).toBe(true);
  });

  it('requires property.propertySet and property.baseName independently', () => {
    const facet: IDSFacet = {
      type: 'property',
      propertySet: undefined as unknown as IDSConstraint,
      baseName: simpleValue('IsExternal'),
    };
    const issues = auditSpecs(specWith({ requirements: [{ id: 'r1', optionality: 'required', facet }] }));
    expect(
      issues.some(
        (i) => i.code === 'E_XSD_REQUIRED_ATTR' && i.message === 'property.propertySet is required'
      )
    ).toBe(true);
    expect(
      issues.some((i) => i.message === 'property.baseName is required')
    ).toBe(false);
  });

  it('flags a simpleValue constraint that is present but empty/whitespace', () => {
    const facet: IDSFacet = { type: 'entity', name: simpleValue('   ') };
    const issues = auditSpecs(specWith({ applicability: { facets: [facet] } }));
    expect(
      issues.some(
        (i) => i.code === 'E_XSD_REQUIRED_ATTR' && i.message === 'entity.name must have a non-empty value'
      )
    ).toBe(true);
  });

  it('accepts a non-empty simpleValue constraint', () => {
    const facet: IDSFacet = { type: 'entity', name: simpleValue('IFCWALL') };
    const issues = auditSpecs(specWith({ applicability: { facets: [facet] } }));
    expect(issues).toEqual([]);
  });

  it('does not apply the emptiness check to non-simpleValue constraint types (division of labour with coherence checks)', () => {
    // A pattern/enumeration/bounds constraint that is present but "empty"
    // in its own sense (empty pattern string, zero enumeration values, no
    // bounds fields) is only `c === undefined`-checked here — `!c` is
    // false because the object exists, and the `c.type === 'simpleValue'`
    // guard skips the emptiness branch entirely. That's runCoherenceAudit's
    // job (E_RESTRICTION_EMPTY), not the XSD audit's.
    const facet: IDSFacet = {
      type: 'entity',
      name: { type: 'pattern', pattern: '' },
    };
    const issues = auditSpecs(specWith({ applicability: { facets: [facet] } }));
    expect(codes(issues)).not.toContain('E_XSD_REQUIRED_ATTR');
  });

  it('does not check partOf facets for required attributes (relation validity lives in the ifc-schema audit)', () => {
    const facet: IDSFacet = { type: 'partOf', relation: 'IfcRelAggregates' };
    const issues = auditSpecs(specWith({ applicability: { facets: [wallFacet, facet] } }));
    expect(issues).toEqual([]);
  });

  it('does not check classification facets for required attributes (all fields optional per XSD)', () => {
    const facet: IDSFacet = { type: 'classification' };
    const issues = auditSpecs(specWith({ applicability: { facets: [wallFacet, facet] } }));
    expect(issues).toEqual([]);
  });

  it('does not check material facets for required attributes (all fields optional per XSD)', () => {
    const facet: IDSFacet = { type: 'material' };
    const issues = auditSpecs(specWith({ applicability: { facets: [wallFacet, facet] } }));
    expect(issues).toEqual([]);
  });
});

describe('runXsdAudit — requirements also run per-facet checks', () => {
  it('audits a requirement facet the same way it audits an applicability facet', () => {
    const facet = { type: 'attribute', name: undefined } as unknown as IDSFacet;
    const issues = auditSpecs(
      specWith({ requirements: [{ id: 'r1', optionality: 'required', facet }] })
    );
    expect(
      issues.some((i) => i.path.startsWith('specifications[0].requirements[0]'))
    ).toBe(true);
  });
});

describe('runXsdAudit — multiple specifications and clean documents', () => {
  it('returns no issues for a well-formed minimal document', () => {
    expect(auditSpecs(specWith({}))).toEqual([]);
  });

  it('indexes issues by specification position across multiple specs', () => {
    const bad = specWith({ name: '' });
    const good = specWith({});
    const issues = auditSpecs(good, bad);
    expect(issues.every((i) => i.path.startsWith('specifications[1]'))).toBe(true);
  });

  it('returns an empty array for a document with no specifications', () => {
    expect(auditDoc({})).toEqual([]);
  });
});
