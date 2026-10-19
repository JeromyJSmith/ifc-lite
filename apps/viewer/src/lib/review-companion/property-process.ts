/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { useReviewProcessJournal } from '@/hooks/useReviewProcessJournal';
import type { ReviewPropertyProposal } from './property-changes';
import type { ReviewProcessChange, ReviewProcessScalar, ReviewProcessFinding } from './process';

type Journal = Pick<ReturnType<typeof useReviewProcessJournal>, 'current' | 'canonicalFindingId' | 'append'>;
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
function scalar(value: unknown): value is ReviewProcessScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
}
const now = () => new Date().toISOString();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Map actual native property lifecycle callbacks to the process contract.
 * This does not approve via a tool, authenticate a human, execute a write, or
 * infer readback from a proposed value. Standalone/unmapped edits are no-ops. */
export function createReviewPropertyProcessEvents(journal: Journal) {
  function mapped(proposal: ReviewPropertyProposal): ReviewProcessFinding | undefined {
    const process = journal.current();
    const id = journal.canonicalFindingId(proposal.findingId);
    return process?.status === 'running' && process.scopeId === proposal.scopeId && id
      ? process.findings.find(finding => finding.id === id) : undefined;
  }
  async function block(finding: ReviewProcessFinding, stage: string, reason: string, recordId: string) {
    await journal.append({ kind: 'block', at: now(), findingId: finding.id, stage, reason, evidenceRefs: [recordId] });
  }
  function proposedChanges(proposal: ReviewPropertyProposal, finding: ReviewProcessFinding): ReviewProcessChange[] | null {
    const rows = proposal.preview.rows;
    if (!finding.element || !rows.length || rows.length > 5 || rows.some(row => row.status !== 'ready'
      || row.modelId !== finding.element!.modelId || row.expressId !== finding.element!.expressId
      || row.change.target.globalId !== finding.element!.ifcGlobalId || !scalar(row.current)
      || row.change.op !== 'property.set' && row.change.op !== 'attribute.set')) return null;
    return rows.map(row => ({ field: row.change.op === 'property.set' ? `${row.change.pset}.${row.change.name}` : row.change.name,
      before: row.current as ReviewProcessScalar, after: row.change.op === 'property.delete' ? null : row.change.value }));
  }
  async function preview(proposal: ReviewPropertyProposal, recordId: string) {
    const finding = mapped(proposal); if (!finding) return;
    const changes = proposedChanges(proposal, finding);
    if (!changes) { await block(finding, 'preview', 'Native preview is not ready for one exact bound element.', recordId); return; }
    await journal.append({ kind: 'preview', at: now(), findingId: finding.id, preview: { id: proposal.id,
      digest: proposal.preview.digest, mutationVersion: proposal.preview.mutationVersion, changes, artifactRef: recordId } });
  }
  /** Call only from the actual native human Apply click, before execution. */
  async function approve(proposal: ReviewPropertyProposal, approvalRecordId: string) {
    const finding = mapped(proposal); if (!finding) return;
    await journal.append({ kind: 'approve', at: now(), findingId: finding.id, previewId: proposal.id,
      digest: proposal.preview.digest, actor: { kind: 'human', id: 'native-review-user' },
      method: 'native-review-click', approvalRef: approvalRecordId });
  }
  function nativeReceipt(outcome: unknown, finding: ReviewProcessFinding, proposal: ReviewPropertyProposal) {
    if (!object(outcome) || !object(outcome.receipt)) return null;
    const receipt = outcome.receipt;
    if (!finding.element || typeof receipt.id !== 'string' || receipt.digest !== proposal.preview.digest ||
      !Array.isArray(receipt.applied) || !receipt.applied.length || !Array.isArray(receipt.batches)) return null;
    const changes: ReviewProcessChange[] = [];
    for (const item of receipt.applied) {
      if (!object(item) || item.modelId !== finding.element.modelId || item.globalId !== finding.element.ifcGlobalId ||
        typeof item.field !== 'string' || !scalar(item.before) || !scalar(item.after)) return null;
      changes.push({ field: item.field, before: item.before, after: item.after });
    }
    const batches: string[] = [];
    for (const item of receipt.batches) {
      if (!object(item) || item.modelId !== finding.element.modelId || typeof item.batchId !== 'string') return null;
      batches.push(item.batchId);
    }
    if (!batches.length || !same(changes, finding.preview?.changes)) return null;
    return { id: receipt.id, digest: String(receipt.digest), modelId: finding.element.modelId,
      globalId: finding.element.ifcGlobalId, changes, nativeBatchIds: batches };
  }
  function readback(outcome: unknown, changes: ReviewProcessChange[], undo: boolean) {
    if (!object(outcome) || outcome.persisted !== true || !Array.isArray(outcome.readback) || outcome.readback.length !== changes.length) return null;
    const values: Array<{ field: string; value: ReviewProcessScalar }> = [];
    for (const [index, item] of outcome.readback.entries()) {
      if (!object(item) || item.index !== index || item.field !== changes[index].field || item.matches !== true || !scalar(item.actual)
        || item.actual !== (undo ? changes[index].before : changes[index].after)) return null;
      values.push({ field: item.field, value: item.actual });
    }
    return values;
  }
  async function applied(proposal: ReviewPropertyProposal, actualOutcome: unknown, recordId: string) {
    const finding = mapped(proposal); if (!finding) return;
    const native = nativeReceipt(actualOutcome, finding, proposal);
    if (!native || !object(actualOutcome) || !object(actualOutcome.receipt) || actualOutcome.receipt.status !== 'applied') {
      await block(finding, 'apply', 'No matching native applied receipt was returned; inspect the actual outcome.', recordId); return;
    }
    await journal.append({ kind: 'apply', at: now(), findingId: finding.id,
      receipt: { ...native, status: 'applied', artifactRef: recordId } });
    const values = readback(actualOutcome, native.changes, false);
    if (!values) { await block(finding, 'verification', 'Native application is recorded, but complete matching readback and durable persistence are not confirmed.', recordId); return; }
    await journal.append({ kind: 'verify', at: now(), findingId: finding.id,
      readback: { receiptId: native.id, modelId: native.modelId, globalId: native.globalId, values, artifactRef: recordId } });
  }
  async function undone(proposal: ReviewPropertyProposal, actualUndo: unknown, recordId: string) {
    const finding = mapped(proposal); if (!finding) return;
    const native = nativeReceipt(actualUndo, finding, proposal);
    const values = native && readback(actualUndo, native.changes, true);
    if (!native || !values || !object(actualUndo) || actualUndo.undone !== true || !object(actualUndo.receipt)
      || actualUndo.receipt.status !== 'undone' || finding.receipt?.id !== native.id) {
      await block(finding, 'undo-verification', 'Native undo lacks matching effective before-value readback or durable persistence; no undo verification was invented.', recordId); return;
    }
    await journal.append({ kind: 'undo', at: now(), findingId: finding.id, undoRef: recordId,
      readback: { receiptId: native.id, modelId: native.modelId, globalId: native.globalId, values, artifactRef: recordId } });
  }
  return { preview, approve, applied, undone };
}
