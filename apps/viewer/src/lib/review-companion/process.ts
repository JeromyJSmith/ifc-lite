/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { Ajv } from 'ajv';
import schema from '../../../../../docs/architecture/review-companion-process.schema.json';

export const reviewProcessSchema = schema;
export type ReviewProcessScalar = string | number | boolean | null;
export interface ReviewProcessElement { modelId: string; expressId: number; ifcGlobalId: string; sourceIdentity: string }
export interface ReviewProcessChange { field: string; before: ReviewProcessScalar; after: ReviewProcessScalar }
export interface ReviewProcessPreview { id: string; digest: string; mutationVersion: number; changes: ReviewProcessChange[]; artifactRef: string }
export interface ReviewProcessReceipt { id: string; digest: string; status: 'applied'; modelId: string; globalId: string; changes: ReviewProcessChange[]; nativeBatchIds: string[]; artifactRef: string }
export interface ReviewProcessReadback { receiptId: string; modelId: string; globalId: string; values: Array<{ field: string; value: ReviewProcessScalar }>; artifactRef: string }
export interface ReviewProcessInspection { id: string; contextRef: string; viewpointId: string; snapshotRef: string; rawResponseRef: string; model: string; summary: string }
export interface ReviewProcessApproval { kind: 'approve'; at: string; findingId: string; previewId: string; digest: string; actor: { kind: 'human'; id: string }; method: 'native-review-click'; approvalRef: string }
export type ReviewProcessEvent =
  | { kind: 'start'; at: string }
  | { kind: 'inspection'; at: string; inspection: ReviewProcessInspection; findings: Array<{ id: string; text: string }> }
  | { kind: 'bind'; at: string; findingId: string; element: ReviewProcessElement }
  | { kind: 'preview'; at: string; findingId: string; preview: ReviewProcessPreview }
  | ReviewProcessApproval
  | { kind: 'apply'; at: string; findingId: string; receipt: ReviewProcessReceipt }
  | { kind: 'verify'; at: string; findingId: string; readback: ReviewProcessReadback }
  | { kind: 'undo'; at: string; findingId: string; readback: ReviewProcessReadback; undoRef: string }
  | { kind: 'dismiss'; at: string; findingId: string; reason: string }
  | { kind: 'block'; at: string; findingId: string; stage: string; reason: string; evidenceRefs: string[] }
  | { kind: 'fail' | 'interrupt'; at: string; reason: string; evidenceRefs: string[] }
  | { kind: 'finish'; at: string; evidenceRefs: string[]; mode?: 'directive' };
export interface ReviewProcessFinding {
  id: string; text: string; inspectionId: string;
  status: 'candidate' | 'bound' | 'previewed' | 'approved' | 'applied' | 'verified' | 'undone' | 'dismissed' | 'blocked';
  element?: ReviewProcessElement; preview?: ReviewProcessPreview; approval?: ReviewProcessApproval;
  receipt?: ReviewProcessReceipt; readback?: ReviewProcessReadback; undoRef?: string; reason?: string;
}
export interface ReviewProcess {
  schemaVersion: 1; id: string; scopeId: string; directive: string;
  models: Array<{ id: string; name: string; sourceIdentity: string }>;
  createdAt: string; updatedAt: string;
  status: 'not-started' | 'running' | 'completed' | 'directive-completed' | 'blocked' | 'failed' | 'interrupted';
  inspections: ReviewProcessInspection[]; findings: ReviewProcessFinding[]; events: ReviewProcessEvent[];
  operation?: { operation_id: string; run_id: string; project_id: string; parent_run_id: string | null; qualification: 'unqualified' | 'structurally-valid' | 'execution-observed' | 'independently-verified' };
  artifacts?: Array<{ uri: string; sha256: string; role: string }>;
}
export type CreateReviewProcessInput = Pick<ReviewProcess, 'id' | 'scopeId' | 'directive' | 'models' | 'createdAt' | 'operation' | 'artifacts'>;
const ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
const validSnapshot = ajv.compile<ReviewProcess>(schema);
const validEvent = ajv.compile({ $ref: `${schema.$id}#/definitions/event` });
function demand(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function shape(value: unknown): asserts value is ReviewProcess {
  demand(validSnapshot(value), ajv.errorsText(validSnapshot.errors));
  demand(Number.isFinite(Date.parse(value.createdAt)) && Number.isFinite(Date.parse(value.updatedAt)), 'Invalid process timestamp.');
  demand(new Set(value.models.map(m => m.id)).size === value.models.length, 'Duplicate source model ID.');
}
export function createReviewProcess(input: CreateReviewProcessInput): ReviewProcess {
  const value: ReviewProcess = { ...structuredClone(input), schemaVersion: 1, updatedAt: input.createdAt, status: 'not-started', inspections: [], findings: [], events: [] };
  shape(value); return value;
}
function reduce(process: ReviewProcess, event: ReviewProcessEvent): ReviewProcess {
  demand(validEvent(event), ajv.errorsText(validEvent.errors));
  demand(Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) >= Date.parse(process.updatedAt), 'Event timestamps must be valid and nondecreasing.');
  const next = structuredClone(process);
  if (event.kind === 'start') {
    demand(next.status === 'not-started', 'Only a new process may start.'); next.status = 'running';
  } else {
    demand(next.status === 'running', 'This process is not running. Retry interrupted or failed work in a new linked run.');
    if (event.kind === 'inspection') {
      demand(!next.inspections.some(row => row.id === event.inspection.id), 'Inspection ID already recorded.');
      demand(next.inspections.length < 12, 'Inspection budget exhausted.');
      demand(next.findings.length + event.findings.length <= 5, 'At most five grounded findings may be recorded.');
      const ids = new Set(next.findings.map(row => row.id));
      for (const finding of event.findings) { demand(!ids.has(finding.id), 'Finding ID already recorded.'); ids.add(finding.id); }
      next.inspections.push(structuredClone(event.inspection));
      next.findings.push(...event.findings.map(row => ({ ...row, inspectionId: event.inspection.id, status: 'candidate' as const })));
    } else if (event.kind === 'finish') {
      if (event.mode === 'directive') {
        demand(next.inspections.length === 0, 'An inspected review must use visual review completion.');
        demand(event.evidenceRefs.length > 0, 'Directive completion requires its recorded response reference.');
        next.status = 'directive-completed';
      } else {
        demand(next.inspections.length > 0, 'Cannot complete a visual review without a recorded inspection.'); next.status = 'completed';
      }
    } else if (event.kind === 'fail' || event.kind === 'interrupt') {
      next.status = event.kind === 'fail' ? 'failed' : 'interrupted';
    } else {
      const findingId = 'findingId' in event ? event.findingId : '';
      const finding = next.findings.find(row => row.id === findingId);
      demand(finding, 'Unknown finding.');
      if (event.kind === 'bind') {
        demand(finding.status === 'candidate', 'Only an unbound candidate can be bound.');
        demand(next.models.some(model => model.id === event.element.modelId && model.sourceIdentity === event.element.sourceIdentity), 'Binding does not match this model revision.');
        finding.element = structuredClone(event.element); finding.status = 'bound';
      } else if (event.kind === 'preview') {
        demand(['bound', 'previewed', 'approved'].includes(finding.status) || (finding.status === 'blocked' && finding.element && !finding.receipt), 'Bind the finding before previewing a change; applied failures require explicit recovery.');
        demand(new Set(event.preview.changes.map(row => row.field)).size === event.preview.changes.length, 'A preview may change each field once.');
        finding.preview = structuredClone(event.preview); delete finding.approval; finding.status = 'previewed';
      } else if (event.kind === 'approve') {
        demand(finding.status === 'previewed' && finding.preview?.id === event.previewId && finding.preview.digest === event.digest, 'Approval must pin the displayed preview and digest.');
        // Only the native human review click handler may emit this event. No
        // agent tool exposes approval; the record does not authenticate identity.
        finding.approval = structuredClone(event); finding.status = 'approved';
      } else if (event.kind === 'apply') {
        demand(finding.status === 'approved' && finding.preview && finding.element, 'Native human approval is required before application.');
        demand(event.receipt.digest === finding.preview.digest && event.receipt.modelId === finding.element.modelId && event.receipt.globalId === finding.element.ifcGlobalId, 'Receipt does not match the approved model/element/preview.');
        demand(canonical(event.receipt.changes) === canonical(finding.preview.changes), 'Receipt values differ from the approved values.');
        finding.receipt = structuredClone(event.receipt); finding.status = 'applied';
      } else if (event.kind === 'verify' || event.kind === 'undo') {
        demand(event.kind === 'verify' ? finding.status === 'applied' : ['applied', 'verified'].includes(finding.status), 'Readback is out of order.');
        const receipt = finding.receipt; demand(receipt, 'No native applied receipt exists.');
        demand(event.readback.receiptId === receipt.id && event.readback.modelId === receipt.modelId && event.readback.globalId === receipt.globalId, 'Readback identifies another receipt or element.');
        const expected = receipt.changes.map(row => ({ field: row.field, value: event.kind === 'undo' ? row.before : row.after }));
        demand(canonical(event.readback.values) === canonical(expected), 'Native readback does not match the recorded values.');
        finding.readback = structuredClone(event.readback); finding.status = event.kind === 'undo' ? 'undone' : 'verified';
        if (event.kind === 'undo') finding.undoRef = event.undoRef;
      } else if (event.kind === 'dismiss') {
        demand(!['applied', 'verified', 'undone'].includes(finding.status), 'Applied changes cannot be dismissed as though they never happened.');
        finding.status = 'dismissed'; finding.reason = event.reason;
      } else if (event.kind === 'block') {
        finding.status = 'blocked'; finding.reason = `${event.stage}: ${event.reason}`;
      }
    }
  }
  next.updatedAt = event.at; next.events.push(structuredClone(event)); shape(next); return next;
}

/** Structural validation plus replay detects forged status jumps and edited history.
 * It does not resolve artifact URIs or prove that a referenced action happened. */
export function validateReviewProcess(value: unknown): { ok: true; process: ReviewProcess } | { ok: false; errors: string[] } {
  try {
    shape(value);
    const { id, scopeId, directive, models, createdAt, operation, artifacts } = value;
    const input: CreateReviewProcessInput = { id, scopeId, directive, models, createdAt,
      ...(operation ? { operation } : {}), ...(artifacts ? { artifacts } : {}) };
    let replayed = createReviewProcess(input);
    for (const event of value.events) replayed = reduce(replayed, event);
    demand(canonical(value) === canonical(replayed), 'Snapshot differs from its replayed append-only history.');
    return { ok: true, process: structuredClone(value) };
  } catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }; }
}
export function transitionReviewProcess(process: ReviewProcess, event: ReviewProcessEvent): ReviewProcess {
  const checked = validateReviewProcess(process);
  demand(checked.ok, checked.ok ? '' : checked.errors.join('; '));
  return reduce(checked.process, event);
}
