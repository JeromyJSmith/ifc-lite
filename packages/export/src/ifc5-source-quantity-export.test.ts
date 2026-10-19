/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { parseIfcx, composeIfcx } from '@ifc-lite/ifcx';
import { contiguousSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { QuantityType } from '@ifc-lite/data';
import { exportSourceQuantityEdits } from './ifc5-source-quantity-export.js';

const path = 'source-wall';
const key = 'bsi::ifc::v5a::Qto_WallBaseQuantities::NetVolume';
async function fixture(typed = false) {
  const file = { header: { id: 'source-preservation-fixture', ifcxVersion: 'ifcx_alpha', dataVersion: '1' },
    imports: [{ uri: 'preserved:custom-schema' }], schemas: { 'owner::evidence': { value: { dataType: 'String' } } },
    ownerExtension: { preserve: ['unknown', 17] }, data: [{ path, attributes: {
      'bsi::ifc::class': { code: 'IfcWall' }, 'bsi::ifc::prop::Name': 'Source wall',
      'owner::evidence': { origin: 'fixture source', nested: [1, 2] },
      'usd::usdgeom::mesh': { points: [[0, 0, 0], [1, 0, 0], [0, 0, 1]], faceVertexCounts: [3], faceVertexIndices: [0, 1, 2] },
      [key]: typed ? { type: 'IfcVolumeMeasure', value: 3.829483 } : 3.829483,
      'bsi::ifc::v5a::Qto_WallBaseQuantities::GrossVolume': 5.206781,
    } }] };
  const source = JSON.stringify(file);
  const bytes = new TextEncoder().encode(source);
  const parsed = await parseIfcx(bytes.buffer);
  const store = { ...parsed, source: contiguousSourceBytes(bytes), schemaVersion: 'IFC5',
    entityIndex: { byId: new Map(), byType: new Map() } } as unknown as IfcDataStore;
  const id = store.entities.getExpressIdByGlobalId(path);
  const view = new MutablePropertyView(store.properties, 'fixture');
  view.setQuantityExtractor(id => store.quantities.getForEntity(id));
  view.setQuantity(id, 'Qto_WallBaseQuantities', 'NetVolume', 3.832499, QuantityType.Volume);
  return { file, source, store, view, id };
}

describe('native IFCX source-preserving quantity saves', () => {
  it('retains an unedited IFCX document after reopening it', async () => {
    const { source, store } = await fixture();
    expect(exportSourceQuantityEdits(store, undefined)).toBe(source);
    expect(exportSourceQuantityEdits(store, new MutablePropertyView(store.properties, 'clean'))).toBe(source);
  });
  for (const typed of [false, true]) it(`retains original source and reimports the quantity (${typed ? 'typed' : 'numeric'})`, async () => {
    const { file, store, view } = await fixture(typed);
    const content = exportSourceQuantityEdits(store, view)!;
    const saved = JSON.parse(content);
    expect(saved.data.slice(0, file.data.length)).toEqual(file.data);
    expect({ ...saved, data: [] }).toEqual({ ...file, data: [] });
    expect(saved.data).toHaveLength(file.data.length + 1);
    const composed = composeIfcx(saved);
    expect(composed.get(path)?.attributes.get(key)).toEqual(typed ? { type: 'IfcVolumeMeasure', value: 3.832499 } : 3.832499);
    const parsed = await parseIfcx(new TextEncoder().encode(content).buffer);
    const quantities = parsed.quantities.getForEntity(parsed.pathToId.get(path)!)[0].quantities;
    expect(quantities.map(q => [q.name, q.value, q.type])).toEqual([
      ['NetVolume', 3.832499, QuantityType.Volume], ['GrossVolume', 5.206781, QuantityType.Volume],
    ]);
    expect(Array.from(parsed.meshes[0].indices)).toEqual([0, 1, 2]);
  });
  it('uses the current overlay after several edits and returns the source after reversal', async () => {
    const { source, store, view, id } = await fixture();
    view.setQuantity(id, 'Qto_WallBaseQuantities', 'NetVolume', 4, QuantityType.Volume);
    const saved = JSON.parse(exportSourceQuantityEdits(store, view)!);
    expect(saved.data.at(-1).attributes[key]).toBe(4);
    expect(saved.data).toHaveLength(2);
    view.setQuantity(id, 'Qto_WallBaseQuantities', 'NetVolume', 3.829483, QuantityType.Volume);
    expect(exportSourceQuantityEdits(store, view)).toBe(source);
  });
  it('does not intercept mixed edit classes or unsupported quantity metadata', async () => {
    const mixed = await fixture();
    mixed.view.setAttribute(mixed.id, 'Name', 'Changed name');
    expect(exportSourceQuantityEdits(mixed.store, mixed.view)).toBeUndefined();
    const unit = await fixture();
    unit.view.setQuantity(unit.id, 'Qto_WallBaseQuantities', 'NetVolume', 3.832499, QuantityType.Volume, 'ft3');
    expect(exportSourceQuantityEdits(unit.store, unit.view)).toBeUndefined();
  });
  it('declines stale parsed source and an ambiguous legacy flat mirror', async () => {
    for (const mirror of [false, true]) {
      const f = await fixture();
      const changed = JSON.parse(f.source);
      if (mirror) changed.data[0].attributes['bsi::ifc::prop::NetVolume'] = 3.829483;
      else changed.data[0].attributes[key] = 999;
      f.store.source = contiguousSourceBytes(new TextEncoder().encode(JSON.stringify(changed)));
      expect(exportSourceQuantityEdits(f.store, f.view)).toBeUndefined();
    }
  });
});
