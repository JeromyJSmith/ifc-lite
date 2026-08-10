/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getRawNamedAttributes` must name attributes across the bundled schema
 * union, not through the IFC4 codegen pin alone — the same defect family as
 * #2001/#2003/#2021 and the `extractAllEntityAttributes` fix. The pin answers
 * an EMPTY list for the ~251 classes it does not carry (the whole IFC4.3
 * infrastructure vocabulary), so the query layer's `EntityNode.allAttributes`
 * — and with it the viewer's attributes panel — silently showed NO attributes
 * for an `IfcCourse`, `IfcPavement`, `IfcSignal`, … while showing them fine
 * for an `IfcWall` in the same model.
 */

import { describe, it, expect } from 'vitest';
import { getRawNamedAttributes } from '../src/columnar-parser.js';
import { getAttributeNames, getAttributeNamesAcrossSchemas } from '../src/ifc-schema.js';
import type { IfcEntity } from '@ifc-lite/data';

function courseEntity(): IfcEntity {
  // IfcCourse (IFC4X3): GlobalId, OwnerHistory, Name, Description, ObjectType,
  // ObjectPlacement, Representation, Tag, PredefinedType
  return {
    expressId: 1,
    type: 'IFCCOURSE',
    attributes: ['0GUID', null, 'Base course', 'unbound layer', 'objtype', null, null, 'C-01', '.PAVEMENT.'],
  };
}

describe('getRawNamedAttributes across the schema union', () => {
  it('IfcCourse is outside the codegen pin (premise)', () => {
    expect(getAttributeNames('IfcCourse')).toHaveLength(0);
    expect(getAttributeNamesAcrossSchemas('IfcCourse').length).toBeGreaterThan(0);
  });

  it('names an IFC4.3 infrastructure entity\'s attributes instead of returning []', () => {
    const rows = getRawNamedAttributes(courseEntity());
    const byName = new Map(rows.map((r) => [r.name, r.raw]));
    expect(byName.get('Name')).toBe('Base course');
    expect(byName.get('Description')).toBe('unbound layer');
    expect(byName.get('Tag')).toBe('C-01');
    expect(byName.get('PredefinedType')).toBe('.PAVEMENT.');
  });

  it('still skips structural attributes (GlobalId/OwnerHistory) on the union path', () => {
    const names = getRawNamedAttributes(courseEntity()).map((r) => r.name);
    expect(names).not.toContain('GlobalId');
    expect(names).not.toContain('OwnerHistory');
  });

  it('BOUND: a pinned IFC4 class answers exactly as before', () => {
    // IfcWall: GlobalId, OwnerHistory, Name, Description, ObjectType,
    // ObjectPlacement, Representation, Tag, PredefinedType — the pinned
    // list, byte-for-byte: the union is only consulted when the pin is empty.
    const wall: IfcEntity = {
      expressId: 2,
      type: 'IfcWall',
      attributes: ['1GUID', null, 'W-1', 'a wall', 'wt', null, null, 'wall-tag', '.SOLIDWALL.'],
    };
    const rows = getRawNamedAttributes(wall);
    expect(rows).toEqual([
      { name: 'Name', raw: 'W-1' },
      { name: 'Description', raw: 'a wall' },
      { name: 'ObjectType', raw: 'wt' },
      { name: 'Tag', raw: 'wall-tag' },
      { name: 'PredefinedType', raw: '.SOLIDWALL.' },
    ]);
  });

  it('BOUND: a vendor extension still answers [] (unknown to pin AND union)', () => {
    const vendor: IfcEntity = {
      expressId: 3,
      type: 'IFCACMEVENDORTHING',
      attributes: ['x', 'y'],
    };
    expect(getRawNamedAttributes(vendor)).toEqual([]);
  });
});
