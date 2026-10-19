/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { MutablePropertyView } from '@ifc-lite/mutations';
import { exportSourceQuantityEdits } from '@ifc-lite/export';
import type { ModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { parseIfcxViewerModel } from '@/hooks/ingest/viewerModelIngest';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import { sha256Hex } from '@/utils/sourceContentHash';
import { readGeometrySource } from './geometry-sources';
import type { ReviewFinding } from './types';

type Data = Record<string, any>;
interface Transaction { identity: string; modelId: string; receiptRef: string; at: string; changes: ModelChangeBatch['changes'] }
export interface QuantityPredecessors { hashes: Set<string>; identities: Set<string>; receiptRefs: Set<string> }
function payload(row: ReviewFinding): Data | null {
  try { const value = JSON.parse(row.text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return null; }
}
function transactions(rows: ReviewFinding[]): Transaction[] {
  const events = rows.map(row => ({ row, data: payload(row) }));
  const result: Transaction[] = [];
  for (const { row, data } of events) {
    const applied = data?.stage === 'property-apply-readback' ? data.result : null;
    const receipt = applied?.receipt;
    if (!applied?.ok || !applied.applied || !applied.persisted || receipt?.status !== 'applied'
      || typeof receipt.digest !== 'string' || !receipt.digest
      || !Array.isArray(receipt.applied) || !receipt.applied.length || !Array.isArray(receipt.skipped) || receipt.skipped.length
      || !Array.isArray(applied.readback) || applied.readback.length !== receipt.applied.length) continue;
    const previews = events.filter(event => event.data?.stage === 'property-preview'
      && event.row.parentId === row.parentId && event.row.context.scopeId === row.context.scopeId
      && event.data.proposal?.preview?.digest === receipt.digest);
    const preview = previews.length === 1 ? previews[0].data?.proposal : null;
    if (!preview || !Array.isArray(preview.batch?.changes) || preview.batch.changes.length !== receipt.applied.length
      || receipt.origin !== `review:${preview.findingId}` || preview.findingId !== row.parentId) continue;
    const approval = events.some(event => event.data?.stage === 'property-owner-approval'
      && event.row.parentId === row.parentId && event.row.context.scopeId === row.context.scopeId
      && event.data.previewId === preview.id && event.data.digest === receipt.digest
      && event.data.method === 'native-review-click');
    if (!approval) continue;
    const identities = new Set<string>(), modelIds = new Set<string>(), fields = new Set<string>();
    let valid = true;
    for (const [index, change] of (preview.batch.changes as ModelChangeBatch['changes']).entries()) {
      const actual = receipt.applied[index], read = applied.readback[index];
      if (change.op !== 'quantity.set' || typeof change.value !== 'number' || !Number.isFinite(change.value)
        || typeof change.expected !== 'number' || !Number.isFinite(change.expected)
        || actual.index !== index || actual.op !== change.op || actual.globalId !== change.target.globalId
        || actual.modelId !== change.target.modelId || actual.field !== `${change.qset}.${change.name}`
        || actual.before !== change.expected || actual.after !== change.value
        || read.index !== index || read.field !== actual.field || read.actual !== change.value || read.matches !== true) { valid = false; break; }
      const elements = row.context.elements.filter(element => element.ifcGlobalId === change.target.globalId);
      const source = elements.length === 1 ? row.context.models.find(model => model.id === elements[0].modelId) : undefined;
      const field = `${change.target.globalId}\0${change.qset}\0${change.name}`;
      if (!source || fields.has(field)) { valid = false; break; }
      fields.add(field); identities.add(source.sourceIdentity); modelIds.add(actual.modelId);
    }
    if (!valid || identities.size !== 1 || modelIds.size !== 1) continue;
    result.push({ identity: [...identities][0], modelId: [...modelIds][0], receiptRef: row.id,
      at: row.createdAt, changes: preview.batch.changes });
  }
  return result.sort((a, b) => a.at.localeCompare(b.at) || a.receiptRef.localeCompare(b.receiptRef));
}

/** Recompute quantity-only revisions from retained source bytes and exact native
 * preview/approval/application/readback records. This qualifies source lineage
 * for restoration, not architectural acceptance or imported actor identity. */
export async function verifiedQuantityPredecessors(
  rows: ReviewFinding[], targets: Array<{ id: string; hash: string | null }>,
): Promise<Map<string, QuantityPredecessors>> {
  const edits = transactions(rows), output = new Map<string, QuantityPredecessors>();
  if (!edits.length) return output;
  const wanted = targets.filter(target => target.hash);
  const manifests = rows.filter(row => payload(row)?.kind === 'review.geometry.source')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const visited = new Set<string>();
  const queue: Array<{ bytes: ArrayBuffer; hash: string; ancestors: QuantityPredecessors }> = [];
  const examine = async (item: typeof queue[number]) => {
    if (visited.has(item.hash)) return;
    visited.add(item.hash);
    const blob = new Blob([item.bytes]);
    const identity = await placementSourceIdentity(blob, undefined, new Uint8Array(item.bytes));
    const identities = new Set([`sha256:${item.hash}`, ...(identity ? [`sha256:${identity}`] : [])]);
    const applicable = edits.filter(edit => identities.has(edit.identity));
    if (!applicable.length) return;
    let parsed: Awaited<ReturnType<typeof parseIfcxViewerModel>>;
    try { parsed = await parseIfcxViewerModel(item.bytes, undefined, { allowEmptyGeometry: true }); }
    catch (error) { console.warn('[review-lineage] Retained quantity source could not be parsed', error); return; }
    // Distinct native load sessions can independently edit the same original
    // file. Only edits from one session share a cumulative in-memory overlay.
    for (const modelId of new Set(applicable.map(edit => edit.modelId))) {
      const view = new MutablePropertyView(parsed.dataStore.properties, modelId);
      view.setQuantityExtractor(id => parsed.dataStore.quantities.getForEntity(id));
      const refs = new Set(item.ancestors.receiptRefs);
      for (const edit of applicable.filter(edit => edit.modelId === modelId)) {
        const prepared: Array<{ id: number; set: string; name: string; value: number; type: number }> = [];
        for (const change of edit.changes) {
          if (change.op !== 'quantity.set') continue;
          const id = parsed.dataStore.entities.getExpressIdByGlobalId(change.target.globalId);
          const qsets = view.getQuantitiesForEntity(id).filter(set => set.name === change.qset);
          const quantities = qsets.length === 1 ? qsets[0].quantities.filter(q => q.name === change.name) : [];
          if (quantities.length !== 1 || quantities[0].value !== change.expected) break;
          prepared.push({ id, set: change.qset, name: change.name, value: change.value as number, type: quantities[0].type });
        }
        if (prepared.length !== edit.changes.length) continue;
        for (const change of prepared) view.setQuantity(change.id, change.set, change.name, change.value, change.type);
        const content = exportSourceQuantityEdits(parsed.dataStore, view);
        if (content === undefined) continue;
        const bytes = new TextEncoder().encode(content).buffer, hash = await sha256Hex(bytes);
        if (!hash || hash === item.hash) continue;
        refs.add(edit.receiptRef);
        const ancestors = { hashes: new Set([...item.ancestors.hashes, item.hash]),
          identities: new Set([...item.ancestors.identities, ...identities]), receiptRefs: new Set(refs) };
        for (const target of wanted) if (target.hash === hash) output.set(target.id, ancestors);
        queue.push({ bytes, hash, ancestors });
      }
    }
  };
  for (const manifest of manifests) {
    if (wanted.every(target => output.has(target.id))) break;
    const sourceHash = payload(manifest)?.hash;
    if (typeof sourceHash !== 'string' || visited.has(sourceHash)) continue;
    try {
      const bytes = await readGeometrySource(manifest.id, rows);
      await examine({ bytes, hash: sourceHash, ancestors: { hashes: new Set(), identities: new Set(), receiptRefs: new Set() } });
      while (queue.length) await examine(queue.shift()!);
    } catch (error) {
      console.warn('[review-lineage] Retained source failed lineage verification', manifest.id, error);
    }
  }
  return output;
}
