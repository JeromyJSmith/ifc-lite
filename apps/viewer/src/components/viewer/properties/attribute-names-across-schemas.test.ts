/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's two remaining pinned-registry attribute-name lookups must
 * resolve across the bundled schema union (same defect family as
 * #2001/#2003/#2021 and the parser's `extractAllEntityAttributes` fix):
 *
 * - `attributesFromOverlayEntity` (PropertiesPanel): an overlay-created
 *   IFC4.3 entity — which the SDK legitimately authors since #2003 — rendered
 *   ZERO attribute rows, because the IFC4 pin answers an empty name list.
 * - `rawStepAttributeNames` (RawStepCard): every row of an IFC4.3 entity was
 *   labeled "Arg N" instead of its schema name, so a user editing e.g. an
 *   IfcCourse could not tell PredefinedType from Tag.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { attributesFromOverlayEntity } from '../PropertiesPanel.js';
import { rawStepAttributeNames } from './RawStepCard.js';

describe('attributesFromOverlayEntity (IFC4.3 overlay entities)', () => {
  it('renders attribute rows for an overlay-created IFC4.3 class', () => {
    // IfcCourse: GlobalId, OwnerHistory, Name, Description, ObjectType,
    // ObjectPlacement, Representation, Tag, PredefinedType
    const rows = attributesFromOverlayEntity({
      expressId: 9001,
      type: 'IfcCourse',
      attributes: ['0GUID', null, 'Base course', 'unbound layer', null, null, null, 'C-01', '.PAVEMENT.'],
    });
    const byName = new Map(rows.map((r) => [r.name, r.value]));
    assert.equal(byName.get('Name'), 'Base course');
    assert.equal(byName.get('Description'), 'unbound layer');
    assert.equal(byName.get('Tag'), 'C-01');
  });

  it('BOUND: a pinned IFC4 class answers exactly as before', () => {
    const rows = attributesFromOverlayEntity({
      expressId: 9002,
      type: 'IfcWall',
      attributes: ['1GUID', null, 'W-1', 'a wall', 'wt', null, null, 'wall-tag'],
    });
    assert.deepEqual(rows, [
      { name: 'GlobalId', value: '1GUID' },
      { name: 'Name', value: 'W-1' },
      { name: 'Description', value: 'a wall' },
      { name: 'ObjectType', value: 'wt' },
      { name: 'Tag', value: 'wall-tag' },
    ]);
  });

  it('BOUND: a vendor extension still renders no rows', () => {
    assert.deepEqual(
      attributesFromOverlayEntity({ expressId: 9003, type: 'IfcAcmeVendorThing', attributes: ['a', 'b'] }),
      [],
    );
  });
});

describe('rawStepAttributeNames (Raw STEP row labels)', () => {
  it('labels IFC4.3 rows with schema names, not "Arg N"', () => {
    const names = rawStepAttributeNames('IFCCOURSE');
    assert.ok(names.length > 0, 'expected a non-empty name list for IfcCourse');
    assert.equal(names[2], 'Name');
    assert.equal(names[8], 'PredefinedType');
  });

  it('BOUND: pinned classes keep the exact pinned labels', () => {
    const names = rawStepAttributeNames('IFCWALL');
    assert.deepEqual(names.slice(0, 5), ['GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType']);
    assert.equal(names[7], 'Tag');
  });

  it('BOUND: unknown types answer [] and fall to "Arg N" labels', () => {
    assert.deepEqual(rawStepAttributeNames('IFCACMEVENDORTHING'), []);
  });
});
