/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreApi } from 'zustand';
import { parseModelChangeBatch, EDITABLE_ATTRIBUTES, type ModelChangeBatch } from '@ifc-lite/ai/artifacts';
import { useViewerStore, type ViewerState } from '@/store';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';
import { resolveGlobalId } from '@/lib/actions/resolve-global-id';
import { modelReader, currentValue, effectiveAttribute, sameValue, UNSUPPORTED_VALUE } from '@/lib/actions/model-change-values';
import { previewModelChanges, type ModelChangePreview } from '@/lib/actions/model-change-preview';
import { changeField, commitModelChanges, undoModelChanges, type ModelChangeReceipt } from '@/lib/actions/model-change-commit';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { rebindReviewModels, reviewModels, reviewScope } from './context';
import type { ReviewFinding } from './types';

export interface ReviewPropertyProposal {
  id: string;
  findingId: string;
  scopeId: string;
  batch: ModelChangeBatch;
  preview: ModelChangePreview;
  origin: string;
}
const DIMENSION_FIELD = /(?:height|width|length|depth|thickness|elevation|offset|position|placement|coordinate|radius|diameter|area|volume|sill|slope|angle)/i;

/**
 * Bridge review tools to the existing native data-edit transaction and Undo.
 * It never derives a corrective value from an image, enables Edit mode, changes
 * geometry, or treats metadata readback as geometry validation. The caller owns
 * authorization of the replacement values in the current user directive.
 */
export function createReviewPropertyBridge(options: {
  findFinding(id: string): ReviewFinding | undefined | Promise<ReviewFinding | undefined>;
  store?: StoreApi<ViewerState>;
}) {
  const store = options.store ?? useViewerStore;
  const proposals = new Map<string, ReviewPropertyProposal>();
  const receipts = new Map<string, ModelChangeReceipt>();
  const receiptPreviews = new Map<string, ReviewPropertyProposal>();
  async function sources() {
    const models = store.getState().models;
    const identities = await reviewModels(models);
    const scopeId = await reviewScope(identities);
    if (store.getState().models !== models) throw new Error('Loaded model revisions changed during property review');
    return { models, identities, scopeId };
  }
  async function readElement(input: { modelId: string; expressId: number }) {
    const scope = await sources();
    const state = store.getState();
    if (!Number.isSafeInteger(input.expressId) || input.expressId < 1) throw new Error('A positive model-local IFC express ID is required');
    const reader = modelReader(state, input.modelId);
    const globalId = resolveEntityRefGlobalIdFromState(state, input);
    if (!reader || !globalId) throw new Error('This element has no resolvable editable IFC identity');
    const resolved = resolveGlobalId(state, { modelId: input.modelId, globalId });
    if (typeof resolved === 'string' || resolved.expressId !== input.expressId) throw new Error('Element identity is missing or ambiguous');
    const sets = reader.view.getForEntity(input.expressId);
    const quantities = reader.view.getQuantitiesForEntity(input.expressId);
    return { scopeId: scope.scopeId, modelId: input.modelId, expressId: input.expressId, ifcGlobalId: globalId,
      mutationVersion: state.mutationVersion,
      attributes: Object.fromEntries(EDITABLE_ATTRIBUTES.map(name => [name, effectiveAttribute(reader, input.expressId, name)])),
      properties: sets.slice(0, 50).map(set => ({ name: set.name, properties: set.properties.slice(0, 100),
        totalProperties: set.properties.length, truncated: set.properties.length > 100 })),
      totalPropertySets: sets.length, truncated: sets.length > 50,
      quantities: quantities.slice(0, 50).map(set => ({ name: set.name, quantities: set.quantities.slice(0, 100),
        totalQuantities: set.quantities.length, truncated: set.quantities.length > 100 })),
      totalQuantitySets: quantities.length, quantitiesTruncated: quantities.length > 50,
      limitation: 'Scalar IFC data only. Property or quantity names do not establish editable geometry or measured dimensions.' };
  }
  async function bind(findingId: string, batch: ModelChangeBatch) {
    const finding = await options.findFinding(findingId);
    if (!finding || finding.id !== findingId) throw new Error('Saved review finding was not found');
    const scope = await sources();
    if (scope.scopeId !== finding.context.scopeId) throw new Error('Load the exact reviewed model revisions before editing this finding');
    const bindings = rebindReviewModels(finding.context.models, scope.identities);
    const state = store.getState();
    if (finding.context.mutationVersion !== undefined && finding.context.mutationVersion !== state.mutationVersion) throw new Error('The model edit revision differs from the reviewed image; inspect it again before proposing a correction');
    for (const change of batch.changes) {
      if (!change.target.modelId) throw new Error('Every review edit must explicitly name its loaded model');
      const refs = finding.context.elements.filter(ref => bindings.get(ref.modelId) === change.target.modelId && ref.ifcGlobalId === change.target.globalId);
      if (refs.length !== 1) throw new Error('Edit target was not uniquely identified by this finding; select and inspect it first');
      const resolved = resolveGlobalId(state, change.target);
      if (typeof resolved === 'string' || resolved.expressId !== refs[0].expressId) throw new Error('The finding element identity no longer matches the loaded model');
    }
    return finding;
  }
  async function previewChanges(input: { findingId: string; batch: ModelChangeBatch }): Promise<ReviewPropertyProposal> {
    const batch = parseModelChangeBatch(JSON.stringify(input.batch));
    if (batch.changes.length > 5) throw new Error('A review property proposal may contain at most five explicit data edits');
    for (const change of batch.changes) {
      if (change.op !== 'property.set' && change.op !== 'attribute.set' && change.op !== 'quantity.set') throw new Error('Review supports scalar property, existing quantity and descriptive attribute edits only');
      if (change.op === 'property.set' && DIMENSION_FIELD.test(change.name)) throw new Error('Dimension or geometry fields require native authoring and independently supplied measurements; a data property must not masquerade as a geometry fix');
    }
    const finding = await bind(input.findingId, batch);
    const proposal: ReviewPropertyProposal = { id: crypto.randomUUID(), findingId: finding.id,
      scopeId: finding.context.scopeId, batch, preview: previewModelChanges(store.getState(), batch), origin: `review:${finding.id}` };
    // Keep the guarded preview private; callers receive a detached review description.
    proposals.set(proposal.id, structuredClone(proposal));
    return proposal;
  }
  async function applyChanges(input: { previewId: string }) {
    const proposal = proposals.get(input.previewId);
    if (!proposal) throw new Error('Review property preview is missing; prepare it first');
    await bind(proposal.findingId, proposal.batch);
    if (proposal.preview.rows.some(row => row.status !== 'ready')) throw new Error('All proposed fields must be ready in the native preview before applying');
    const outcome = commitModelChanges(store, proposal.preview, new Set(proposal.preview.rows.map(row => row.index)), proposal.origin);
    if (!outcome.ok) return outcome;
    const receipt = outcome.receipt;
    receipts.set(receipt.id, receipt); receiptPreviews.set(receipt.id, proposal);
    proposals.delete(proposal.id);
    const readback = proposal.preview.rows.map(row => {
      const reader = row.modelId && modelReader(store.getState(), row.modelId);
      const actual = reader && row.expressId !== null ? currentValue(reader, row.expressId, row.change) : UNSUPPORTED_VALUE;
      const expected = row.change.op === 'property.delete' ? null : row.change.value;
      return { index: row.index, field: changeField(row.change),
        actual: actual === UNSUPPORTED_VALUE ? null : actual, matches: sameValue(actual, expected, row.change.op === 'attribute.set') };
    });
    if (readback.some(row => !row.matches)) {
      const rollback = undoModelChanges(store, receipt);
      const recorded = rollback.ok ? { ...receipt, status: 'undone' as const, undoneAt: new Date().toISOString() } : receipt;
      receipts.set(recorded.id, recorded);
      const persisted = await modelChangeLibrary.put(recorded.id, recorded);
      return { ok: false, reason: 'readback-mismatch', receipt: recorded, readback, rollback, persisted };
    }
    const persisted = await modelChangeLibrary.put(receipt.id, receipt);
    return { ok: persisted, applied: true, persisted, receipt, readback,
      limitation: 'Effective IFC data readback verified. This did not change or validate geometry, measurements, compliance, or saved file export.' };
  }
  async function undoChanges(input: { receiptId: string }) {
    const receipt = receipts.get(input.receiptId);
    if (!receipt) throw new Error('No property transaction from this review session has that receipt ID');
    const outcome = undoModelChanges(store, receipt);
    if (!outcome.ok) return outcome;
    const undone = { ...receipt, status: 'undone' as const, undoneAt: new Date().toISOString() };
    receipts.set(undone.id, undone);
    const persisted = await modelChangeLibrary.put(undone.id, undone);
    const proposal = receiptPreviews.get(receipt.id);
    if (!proposal) throw new Error('Original fields are unavailable for undo readback; native undo completed but was not verified.');
    const readback = proposal.preview.rows.map(row => {
      const reader = row.modelId && modelReader(store.getState(), row.modelId);
      const actual = reader && row.expressId !== null ? currentValue(reader, row.expressId, row.change) : UNSUPPORTED_VALUE;
      return { index: row.index, field: changeField(row.change),
        actual: actual === UNSUPPORTED_VALUE ? null : actual, matches: sameValue(actual, row.current ?? null, row.change.op === 'attribute.set') };
    });
    return { ok: persisted && readback.every(row => row.matches), undone: true, persisted, receipt: undone, readback };
  }
  return { readElement, previewChanges, applyChanges, undoChanges };
}
