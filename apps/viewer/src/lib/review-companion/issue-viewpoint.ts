/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { ReviewContext, ReviewFinding } from './types';
export interface RepairViewBinding { modelId: string; sourceHash: string; sourceIdentity: string; receiptRef: string }
/** Capture actual pixels and identities; preserve the row before installing its BCF projection. */
export async function saveIssueViewpoint(options: {
  topicId: string; note: string; binding?: RepairViewBinding;
  capture(): Promise<ReviewContext>; qualify?(context: ReviewContext): Promise<void>;
  persist(row: ReviewFinding): Promise<string>; install(context: ReviewContext): Promise<boolean>;
}) {
  const context = await options.capture(), binding = options.binding;
  if (!context.viewpoint.snapshot) throw new Error('The current issue view has no captured image.');
  if (binding && (!/^[a-f0-9]{64}$/.test(binding.sourceHash) || !binding.receiptRef
    || !binding.sourceIdentity || !context.models.some(model => model.id === binding.modelId && model.sourceIdentity === binding.sourceIdentity))) {
    throw new Error('The captured view does not match the repaired source.');
  }
  await options.qualify?.(context);
  const row: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'note', context,
    createdAt: new Date().toISOString(), text: JSON.stringify({ kind: 'review.bcf.viewpoint', topicId: options.topicId,
      note: options.note, ...(binding ? { receiptRef: binding.receiptRef, sourceHash: binding.sourceHash, sourceIdentity: binding.sourceIdentity } : {}) }) };
  if (await options.persist(row) !== row.id) throw new Error('Issue viewpoint persistence returned a different identity.');
  if (!await options.install(context)) throw new Error('The native BCF viewpoint did not match its persisted image. The saved row remains recoverable.');
  return { saved: true, topicId: options.topicId, viewpointRef: row.id, viewpointId: context.viewpoint.guid,
    elementCount: context.elements.length, ...(binding ? { receiptRef: binding.receiptRef, sourceHash: binding.sourceHash } : {}) };
}
