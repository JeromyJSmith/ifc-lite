/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getAllAttributesForEntityAcrossSchemas` — the TYPED counterpart of
 * `getAttributeNamesAcrossSchemas`.
 *
 * The IFC4 codegen pin answers an empty attribute list for IFC4.3-only
 * classes. The names-only union tables closed that for name lookups, but
 * type-driven consumers (the STEP exporter's unit-normalization plan) need
 * the EXPRESS type of each slot, which only the codegen-derived IFC4X3 delta
 * table carries. Both halves are asserted: the delta must ADD classes without
 * moving the answer for a class the pin already knew.
 */

import { describe, expect, it } from 'vitest';
import {
  getAllAttributesForEntity,
  getAllAttributesForEntityAcrossSchemas,
  getAttributeNamesAcrossSchemas,
} from './index.js';

describe('getAllAttributesForEntityAcrossSchemas', () => {
  it('returns the exact pinned-registry result for an IFC4 class', () => {
    expect(getAllAttributesForEntityAcrossSchemas('IFCEXTRUDEDAREASOLID'))
      .toEqual(getAllAttributesForEntity('IFCEXTRUDEDAREASOLID'));
    expect(getAllAttributesForEntityAcrossSchemas('IfcWall'))
      .toEqual(getAllAttributesForEntity('IfcWall'));
  });

  it('types the slots of an IFC4.3-only class the pin does not carry', () => {
    expect(getAllAttributesForEntity('IFCALIGNMENTCANT')).toEqual([]);
    const attrs = getAllAttributesForEntityAcrossSchemas('IFCALIGNMENTCANT');
    expect(attrs).toHaveLength(8);
    expect(attrs[7]).toEqual({
      name: 'RailHeadDistance',
      type: 'IfcPositiveLengthMeasure',
      optional: false,
      isArray: false,
      isList: false,
      isSet: false,
    });
  });

  it('carries aggregate and optional flags for delta classes', () => {
    const attrs = getAllAttributesForEntityAcrossSchemas('IFCOPENCROSSPROFILEDEF');
    const widths = attrs.find((a) => a.name === 'Widths');
    expect(widths).toMatchObject({ type: 'IfcNonNegativeLengthMeasure', isList: true, isSet: false, optional: false });
    const tags = attrs.find((a) => a.name === 'Tags');
    expect(tags).toMatchObject({ type: 'IfcLabel', isList: true, optional: true });
  });

  it('agrees with the names-only union lookup on order and arity', () => {
    for (const type of ['IFCALIGNMENTCANT', 'IFCCLOTHOID', 'IFCALIGNMENTHORIZONTALSEGMENT']) {
      expect(getAllAttributesForEntityAcrossSchemas(type).map((a) => a.name))
        .toEqual(getAttributeNamesAcrossSchemas(type));
    }
  });

  it('resolves draft-leaf aliases the same way the name lookup does', () => {
    // IfcSolidStratum is aliased to IfcGeotechnicalStratum (issue #860).
    expect(getAllAttributesForEntityAcrossSchemas('IFCSOLIDSTRATUM').map((a) => a.name))
      .toEqual(getAttributeNamesAcrossSchemas('IFCSOLIDSTRATUM'));
    expect(getAllAttributesForEntityAcrossSchemas('IFCSOLIDSTRATUM').length).toBeGreaterThan(0);
  });

  it('answers empty for unknown and IFC2X3-only classes', () => {
    expect(getAllAttributesForEntityAcrossSchemas('IFCNOTATHING')).toEqual([]);
    // IFC2X3-only: no bundled EXPRESS source to type it from.
    expect(getAllAttributesForEntityAcrossSchemas('IFCMOVE')).toEqual([]);
  });
});
