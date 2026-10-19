/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { parseIfcx } from '@ifc-lite/ifcx';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StringTable, EntityTableBuilder, PropertyTableBuilder,
  RelationshipGraphBuilder, QuantityTableBuilder, QuantityType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { Ifc5Exporter } from './ifc5-exporter.js';

// Pure in-memory fixture: this is an exporter regression, not a project mutation receipt.
function fixture() {
  const strings = new StringTable();
  const entities = new EntityTableBuilder(1, strings);
  entities.add(1, 'IFCWALL', 'quantity-wall', 'Quantity wall', '', '');
  const quantities = new QuantityTableBuilder(strings);
  for (const [name, value] of [['NetVolume', 3.829483], ['GrossVolume', 5.206781]] as const) {
    quantities.add({ entityId: 1, qsetName: 'Qto_WallBaseQuantities', qsetGlobalId: '',
      quantityName: name, quantityType: QuantityType.Volume, value });
  }
  const table = quantities.build();
  const store = { fileSize: 0, schemaVersion: 'IFC4', entityCount: 1, parseTime: 0,
    source: new Uint8Array(), entityIndex: { byId: new Map(), byType: new Map() },
    strings, entities: entities.build(), properties: new PropertyTableBuilder(strings).build(),
    quantities: table, relationships: new RelationshipGraphBuilder().build() } as unknown as IfcDataStore;
  const view = new MutablePropertyView(null, 'quantity-fixture');
  view.setQuantityExtractor(id => table.getForEntity(id));
  view.setQuantity(1, 'Qto_WallBaseQuantities', 'NetVolume', 3.832499, QuantityType.Volume);
  return { store, view };
}

async function quantitiesAfterExport(applyMutations: boolean) {
  const { store, view } = fixture();
  const result = new Ifc5Exporter(store, null, view).export({ onlyTreeEntities: false,
    includeProperties: true, onlyKnownProperties: false, applyMutations });
  const parsed = await parseIfcx(new TextEncoder().encode(result.content).buffer as ArrayBuffer);
  const index = Array.from({ length: parsed.entities.count }, (_, i) => i)
    .find(i => parsed.strings.get(parsed.entities.name[i]) === 'Quantity wall');
  if (index === undefined) throw new Error('Export lost the target wall');
  return parsed.quantities.getForEntity(parsed.entities.expressId[index])
    .map(set => ({ name: set.name, quantities: set.quantities.map(q => ({ name: q.name, value: q.value, type: q.type })) }));
}

describe('IFCX quantity correction persistence', () => {
  it('reimports the corrected quantity and preserves its unedited sibling', async () => {
    expect(await quantitiesAfterExport(true)).toEqual([{ name: 'Qto_WallBaseQuantities', quantities: [
      { name: 'NetVolume', value: 3.832499, type: QuantityType.Volume },
      { name: 'GrossVolume', value: 5.206781, type: QuantityType.Volume },
    ] }]);
  });
  it('exports original quantities when mutations are explicitly excluded', async () => {
    expect(await quantitiesAfterExport(false)).toEqual([{ name: 'Qto_WallBaseQuantities', quantities: [
      { name: 'NetVolume', value: 3.829483, type: QuantityType.Volume },
      { name: 'GrossVolume', value: 5.206781, type: QuantityType.Volume },
    ] }]);
  });
});
