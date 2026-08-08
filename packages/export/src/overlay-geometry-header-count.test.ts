/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the OVERLAY-CREATED half of `willBeEmitted`'s geometry guard
 * in step-exporter.ts (`return !isGeometryExcluded(entityId, ref.type);` on
 * the `effective.isOverlayCreated(entityId)` branch).
 *
 * `includegeometry-header-count.test.ts` covers the sibling SOURCE-entity
 * branch (an attribute edit on an existing geometry-classified host). This
 * file covers the overlay-created path: a geometry-classified entity added
 * through the mutation overlay (`store.addEntity` / `editor.addEntity`), with
 * a pset attached, exported under `includeGeometry: false`. The overlay
 * new-entities pass (step-exporter.ts, the `getNewEntities()` loop) already
 * skips the host's own defining line via its own `isGeometryEntity` check —
 * that part is not in question. What's in question is whether `willBeEmitted`
 * agrees for that SAME host id when deciding whether to generate the pset
 * entities the `newPropertySets` loop guards behind it: if `willBeEmitted`
 * disagreed (always answered true for an overlay-created id, regardless of
 * geometry), the pset atoms would still be generated and counted, dangling
 * off a host `#id` that the new-entities pass never actually emitted — a
 * relation pointing at a line the file doesn't contain, and a header claiming
 * a modification `DATA` doesn't hold.
 *
 * Every assertion here is against the emitted file TEXT, never against an
 * internal counter alone, matching the rest of this file's siblings.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The "N modification(s)" count the HEADER's FILE_DESCRIPTION claims, or
 *  null when the header makes no such claim. */
function headerClaimedModifications(stepText: string): number | null {
  const m = /Re-exported by ifc-lite, (\d+) modification/.exec(stepText);
  return m ? Number(m[1]) : null;
}

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

describe('STEP header modification count vs includeGeometry:false, overlay-created entity', () => {
  it('a pset added to an overlay-created geometry-classified entity excluded by includeGeometry:false must not claim a modification the DATA section does not contain', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);

    // IFCSHAPEREPRESENTATION is on `isGeometryEntity`'s list. Created through
    // the overlay (not present in the source buffer at all), so this hits the
    // `effective.isOverlayCreated(entityId)` branch of `willBeEmitted`, not the
    // source-entity branch the sibling test covers.
    const created = editor.addEntity('IFCSHAPEREPRESENTATION', [null, 'Body', 'SweptSolid', []]);
    editor.addPropertySet(created.expressId, 'Pset_ScanMetadata', [
      { name: 'Source', value: 'overlay-created', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      includeGeometry: false,
    });
    const text = new TextDecoder().decode(result.content);

    // The geometry host line must actually be gone.
    expect(text).not.toContain('IFCSHAPEREPRESENTATION');
    // ...and no orphaned pset atom for it either — a real bug would emit the
    // pset/rel pair pointing at a host line that was never written.
    expect(text).not.toContain('Pset_ScanMetadata');
    // ...and the header must not claim a modification for it.
    expect(result.stats.newEntityCount).toBe(0);
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('bounding control: the SAME overlay-created entity + pset with geometry included still emits the host line, the pset, and reports the modification', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);

    const created = editor.addEntity('IFCSHAPEREPRESENTATION', [null, 'Body', 'SweptSolid', []]);
    editor.addPropertySet(created.expressId, 'Pset_ScanMetadata', [
      { name: 'Source', value: 'overlay-created', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain('IFCSHAPEREPRESENTATION');
    expect(text).toMatch(/IFCPROPERTYSET\([^)]*'Pset_ScanMetadata'/);
    expect(result.stats.newEntityCount).toBeGreaterThan(0);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
  });
});
