/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { composeIfcx, isTypedPropertyValue, type IfcxFile } from '@ifc-lite/ifcx';

/**
 * Preserve a native IFCX document when only existing, set-qualified quantity
 * values changed. This uses the importer's existing later-opinion semantics,
 * retaining unknown source attributes, geometry, schemas and relationships.
 * Undefined means the conversion exporter must handle a different edit class;
 * never claim source preservation for an unsupported edit or path rewrite.
 */
export function exportSourceQuantityEdits(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
): string | undefined {
  if (store.schemaVersion !== 'IFC5') return undefined;
  const edits = view?.getMutations().filter(edit => edit.type !== 'SESSION_EDIT') ?? [];
  if (edits.some(edit => edit.type !== 'UPDATE_QUANTITY')) return undefined;
  const source = new TextDecoder('utf-8', { fatal: true }).decode(store.source.materialize());
  let file: IfcxFile;
  try { file = JSON.parse(source) as IfcxFile; } catch { return undefined; }
  if (!file.header || !Array.isArray(file.data) || !Array.isArray(file.imports) || !file.schemas) return undefined;
  if (!edits.length) return view?.hasPendingChanges() ? undefined : source;
  if (!view) return undefined;
  const composed = composeIfcx(file);
  const overlays = new Map<string, Record<string, unknown>>();
  for (const edit of edits) {
    const path = store.entities.getGlobalId(edit.entityId);
    const set = edit.psetName, name = edit.propName;
    if (!path || !set || !name || set.includes('::') || name.includes('::') || set.startsWith('Pset_')) return undefined;
    const node = composed.get(path);
    if (!node) return undefined;
    const key = `bsi::ifc::v5a::${set}::${name}`;
    if (!node.attributes.has(key)) return undefined;
    const baseSets = store.quantities.getForEntity(edit.entityId).filter(q => q.name === set);
    if (baseSets.length !== 1) return undefined;
    const original = baseSets[0].quantities.find(q => q.name === name);
    const effectiveSets = view.getQuantitiesForEntity(edit.entityId, id => store.quantities.getForEntity(id)).filter(q => q.name === set);
    const effective = effectiveSets.length === 1 ? effectiveSets[0].quantities.find(q => q.name === name) : undefined;
    if (!original || !effective || !Number.isFinite(effective.value)
      || effective.type !== original.type || effective.unit !== original.unit || effective.formula !== original.formula) return undefined;
    const authored = node.attributes.get(key);
    const current = isTypedPropertyValue(authored) ? authored.value : authored;
    if (current !== original.value) return undefined;
    const flat = `bsi::ifc::prop::${name}`;
    // A changed qualified value must not expose a stale flat mirror as a
    // second quantity on re-import. Leave that conversion to the general path.
    if (node.attributes.has(flat) && effective.value !== original.value) return undefined;
    if (effective.value === original.value) continue; // Undo: retain the original document.
    const attributes = overlays.get(path) ?? {};
    attributes[key] = isTypedPropertyValue(authored) ? { ...authored, value: effective.value } : effective.value;
    overlays.set(path, attributes);
  }
  if (!overlays.size) return source;
  return JSON.stringify({ ...file, data: [...file.data,
    ...Array.from(overlays, ([path, attributes]) => ({ path, attributes }))] });
}
