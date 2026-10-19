/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { createReviewTool } from './tools';
import type { ReviewFinding } from './types';

export const ISSUE_STAGES = ['open', 'investigating', 'needs-evidence', 'ready-to-fix', 'fixed', 'dismissed', 'reopened'] as const;
export type IssueStage = typeof ISSUE_STAGES[number];
export interface IssueUpdate {
  topicId: string;
  stage: IssueStage;
  diagnosis: string;
  evidenceRefs: string[];
  mutationReceiptRef?: string;
  verificationRef?: string;
}
interface WorkflowEvent extends IssueUpdate { kind: 'review.bcf.workflow'; createdAt: string }
interface Definition { kind: 'review.bcf.definition'; topicId: string; findingId: string; title: string; description: string; createdAt: string }
function payload(row: ReviewFinding): Record<string, unknown> | null {
  if (!row.text.startsWith('{')) return null;
  try { const parsed: unknown = JSON.parse(row.text); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; }
  catch { return null; }
}
function definition(row: ReviewFinding): Definition | null {
  const p = payload(row);
  return p?.kind === 'review.bcf.definition' && typeof p.topicId === 'string' && typeof p.findingId === 'string' && typeof p.title === 'string'
    && typeof p.description === 'string' && typeof p.createdAt === 'string' && Number.isFinite(Date.parse(p.createdAt)) ? p as unknown as Definition : null;
}
function event(row: ReviewFinding): WorkflowEvent | null {
  const p = payload(row);
  return p?.kind === 'review.bcf.workflow' && typeof p.topicId === 'string' && ISSUE_STAGES.includes(p.stage as IssueStage)
    && typeof p.diagnosis === 'string' && Array.isArray(p.evidenceRefs) && p.evidenceRefs.every(ref => typeof ref === 'string')
    && typeof p.createdAt === 'string' && Number.isFinite(Date.parse(p.createdAt)) ? p as unknown as WorkflowEvent : null;
}
export interface IssueWorkflowOptions {
  /** Query original review scopes too: an edit must not hide its originating issue. */
  rows(): Promise<ReviewFinding[]>;
  persist(row: ReviewFinding): Promise<string>;
  restore(findingId: string): Promise<unknown>;
  /** Trusted native adapter checks receipt type, issue association, actual mutation and after-state. */
  verify(update: IssueUpdate): Promise<void>;
  onStatus?(topicId: string, stage: IssueStage): void | Promise<void>;
}
export function createIssueWorkflow(options: IssueWorkflowOptions) {
  let writing = false;
  async function list() {
    const rows = await options.rows();
    const events = rows.flatMap(row => { const value = event(row); return value ? [{ row, value }] : []; })
      .sort((a, b) => Date.parse(a.value.createdAt) - Date.parse(b.value.createdAt));
    const seen = new Set<string>();
    return rows.flatMap(row => {
      const d = definition(row);
      if (!d || seen.has(d.topicId)) return [];
      seen.add(d.topicId);
      const latest = events.filter(e => e.value.topicId === d.topicId && e.row.context.scopeId === row.context.scopeId).at(-1);
      return [{ ...d, definitionRef: row.id, scopeId: row.context.scopeId, context: structuredClone(row.context),
        contextElementCount: row.context.elements.length, stage: latest?.value.stage ?? 'open' as IssueStage,
        diagnosis: latest?.value.diagnosis ?? '', evidenceRefs: latest?.value.evidenceRefs ?? [],
        mutationReceiptRef: latest?.value.mutationReceiptRef, verificationRef: latest?.value.verificationRef,
        workflowRef: latest?.row.id, updatedAt: latest?.value.createdAt ?? d.createdAt }];
    }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
  async function record(update: IssueUpdate) {
    if (writing) throw new Error('An issue workflow update is already being saved.');
    if (!ISSUE_STAGES.includes(update.stage) || !update.diagnosis.trim() || update.diagnosis.length > 8000
      || !Array.isArray(update.evidenceRefs) || update.evidenceRefs.length > 100 || update.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) throw new Error('Supply an issue stage, a concrete diagnosis and valid evidence references.');
    writing = true;
    try {
      const rows = await options.rows();
      const original = rows.find(row => definition(row)?.topicId === update.topicId);
      if (!original) throw new Error('No saved BCF issue has this topic ID.');
      const refs = [...update.evidenceRefs, update.mutationReceiptRef, update.verificationRef].filter((ref): ref is string => !!ref);
      for (const ref of refs) if (!rows.some(row => row.id === ref)) throw new Error(`Evidence record ${ref} has not been persisted.`);
      if (update.stage === 'fixed') {
        if (!update.mutationReceiptRef || !update.verificationRef || update.mutationReceiptRef === update.verificationRef) throw new Error('A fixed issue needs distinct persisted native mutation and after-state verification records.');
        if (!update.evidenceRefs.includes(update.mutationReceiptRef) || !update.evidenceRefs.includes(update.verificationRef)) throw new Error('The fix evidence must include both mutation and verification records.');
        await options.verify(update);
      }
      const createdAt = new Date().toISOString();
      const value: WorkflowEvent = { ...structuredClone(update), kind: 'review.bcf.workflow', createdAt };
      const row: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'note', parentId: original.id,
        text: JSON.stringify(value), createdAt, context: structuredClone(original.context), provider: original.provider };
      await options.persist(row);
      // Native BCF status is a projection; the durable event always precedes it.
      await options.onStatus?.(update.topicId, update.stage);
      return { ...value, workflowRef: row.id, saved: true };
    } finally { writing = false; }
  }
  async function open(topicId: string) {
    const issue = (await list()).find(item => item.topicId === topicId);
    if (!issue) throw new Error('No saved BCF issue has this topic ID.');
    await options.restore(issue.findingId);
    return issue;
  }
  async function investigate(topicId: string) {
    const issue = await open(topicId);
    return record({ topicId, stage: 'investigating', diagnosis: 'Restored the original issue camera and selected surrounding elements for investigation.', evidenceRefs: [...new Set([issue.definitionRef, ...issue.evidenceRefs])].slice(0, 100) });
  }
  return { list, record, investigate, open };
}
/** Persist native contact facts without asking a model to restate or approve the measurement. */
export async function recordContactMeasurement(workflow: Pick<ReturnType<typeof createIssueWorkflow>, 'list' | 'record'>, input: {
  topicId: string; expectedWorkflowRef: string | undefined; evidenceRef: string; sourceHash: string;
  pathA: string; pathB: string; contactCount: number; distance: number | null; instanceA: number; triangleA: number;
}) {
  const issue = (await workflow.list()).find(row => row.topicId === input.topicId);
  if (!issue || issue.workflowRef !== input.expectedWorkflowRef || issue.stage === 'fixed' || issue.stage === 'dismissed') throw new Error('Issue changed during measurement. Native evidence is preserved; newer disposition was not overwritten.');
  if (!/^[a-f0-9]{64}$/.test(input.sourceHash) || !Number.isSafeInteger(input.contactCount) || input.contactCount < 0
    || (input.distance !== null && (!Number.isFinite(input.distance) || input.distance < 0))) throw new Error('Native contact facts are invalid.');
  return workflow.record({ topicId: input.topicId, stage: 'needs-evidence',
    diagnosis: `Native contact measurement of ${input.pathA} against ${input.pathB}, composed instance ${input.instanceA}, triangle ${input.triangleA}: ${input.contactCount} contact clusters; nearest distance ${input.distance ?? 'unavailable'} source units. Source ${input.sourceHash}. This records measured model surfaces; architectural intent and issue-specific repair acceptance remain unverified.`,
    evidenceRefs: [...new Set([input.evidenceRef, ...issue.evidenceRefs])].slice(0, 100) });
}
/** Record native effects before another model turn can fail or misstate them. */
export async function recordGeometryApplication(workflow: Pick<ReturnType<typeof createIssueWorkflow>, 'list' | 'record'>, applied: {
  topicId: string; operation: string; receiptRef: string; verificationRef: string; sourceHash: string;
  sourceVerified: boolean; beforeFaces: number | null; afterFaces: number | null; diagnosis: string; viewpointRef?: string;
}) {
  const issue = (await workflow.list()).find(row => row.topicId === applied.topicId);
  if (!issue) throw new Error('Applied geometry issue is missing; native receipts remain preserved.');
  const refs = [...new Set([applied.receiptRef, applied.verificationRef, ...(applied.viewpointRef ? [applied.viewpointRef] : []), ...issue.evidenceRefs])].slice(0, 100);
  return workflow.record({ topicId: applied.topicId, stage: 'needs-evidence', evidenceRefs: refs,
    diagnosis: [
      'Native geometry ' + applied.operation + ' applied. Faces ' + applied.beforeFaces + ' → ' + applied.afterFaces + '.',
      'Current source: ' + applied.sourceHash + '. Source readback ' + (applied.sourceVerified ? 'matched.' : 'DID NOT MATCH; investigate before further edits.'),
      applied.diagnosis.slice(0, 6000),
      applied.viewpointRef ? 'Actual repaired image and camera are attached.' : 'The repaired after-view still needs to be saved.',
      'Application and readback records are attached. Issue-specific architectural acceptance remains pending.',
    ].join(' ') });
}
/** Owner edits are exact text, preserving the current stage and all native evidence. */
export async function saveIssueDiagnosis(workflow: Pick<ReturnType<typeof createIssueWorkflow>, 'list' | 'record'>, input: {
  topicId: string; expectedWorkflowRef: string | undefined; diagnosis: string;
}) {
  const issue = (await workflow.list()).find(row => row.topicId === input.topicId);
  if (!issue || issue.workflowRef !== input.expectedWorkflowRef) throw new Error('Issue changed while its note was being edited. Your text is retained; review the current outcome before saving.');
  return workflow.record({ topicId: issue.topicId, stage: issue.stage, diagnosis: input.diagnosis,
    evidenceRefs: [...issue.evidenceRefs], mutationReceiptRef: issue.mutationReceiptRef, verificationRef: issue.verificationRef });
}
export function createIssueWorkflowTools(workflow: ReturnType<typeof createIssueWorkflow>) {
  const id = { type: 'string' as const, minLength: 1, maxLength: 200 };
  return [
    createReviewTool('review_issue_queue', 'List every saved BCF issue with its original camera and selection, current investigation stage, diagnosis and evidence references, including issues whose source was edited.', {}, true, async () => (await workflow.list()).map(({ context, ...issue }) => ({ ...issue, elements: context.elements, models: context.models, viewpointId: context.viewpoint.guid }))),
    createReviewTool('review_investigate_issue', 'Restore the saved issue viewpoint and surrounding selection and persist an investigating event. Then inspect from additional views and measure before proposing a repair.', { topicId: id }, false, input => workflow.investigate(input.topicId as string)),
    createReviewTool('review_update_issue', 'Persist an issue-specific diagnosis, evidence or blocker. evidenceRefsJson is a JSON array of existing saved review record IDs. For fixed, supply distinct genuine mutationReceiptRef and verificationRef (automatically included in the evidence list): native readback must independently verify the repair. Use empty strings for receipt refs when not fixing.', {
      topicId: id, stage: { type: 'string', enum: [...ISSUE_STAGES] }, diagnosis: { type: 'string', minLength: 1, maxLength: 8000 },
      evidenceRefsJson: { type: 'string', maxLength: 24000 }, mutationReceiptRef: { type: 'string', maxLength: 200 }, verificationRef: { type: 'string', maxLength: 200 },
    }, false, input => {
      const refs: unknown = JSON.parse(input.evidenceRefsJson as string);
      if (!Array.isArray(refs) || !refs.every(ref => typeof ref === 'string')) throw new Error('evidenceRefsJson must be a JSON array of saved record IDs.');
      return workflow.record({ topicId: input.topicId as string, stage: input.stage as IssueStage, diagnosis: input.diagnosis as string,
        evidenceRefs: [...new Set([...refs, input.mutationReceiptRef as string, input.verificationRef as string].filter(Boolean))], mutationReceiptRef: input.mutationReceiptRef as string || undefined, verificationRef: input.verificationRef as string || undefined });
    }),
  ];
}
