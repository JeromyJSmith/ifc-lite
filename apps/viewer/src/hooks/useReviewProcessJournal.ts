/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useCallback, useRef, useState } from 'react';
import { sha256Hex } from '@/utils/sourceContentHash';
import { createReviewProcess, reviewProcessSchema, transitionReviewProcess, validateReviewProcess,
  type ReviewProcess, type ReviewProcessEvent } from '@/lib/review-companion/process';
import type { ReviewContext, ReviewFinding } from '@/lib/review-companion/types';

const instant = () => new Date().toISOString();
const digest = async (text: string) => {
  const value = await sha256Hex(new TextEncoder().encode(text));
  if (!value) throw new Error('Secure hashing is unavailable; the process remains in memory until it can be saved.');
  return value;
};

/** Persist a complete immutable snapshot using the existing append-only notes.
 * Chunking preserves the full record rather than truncating it to the note cap. */
export async function persistReviewProcessSnapshot(process: ReviewProcess, context: ReviewContext,
  persist: (finding: ReviewFinding) => Promise<string>, parentId?: string): Promise<string> {
  const checked = validateReviewProcess(process);
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  return persistReviewJsonSnapshot(process, context, persist, parentId, 'review.process');
}

/** Reusable append-only JSON persistence for process and AG-UI snapshots. */
export async function persistReviewJsonSnapshot(value: unknown, context: ReviewContext,
  persist: (finding: ReviewFinding) => Promise<string>, parentId?: string, kind = 'review.artifact'): Promise<string> {
  if (!/^review\.[a-z][a-z0-9.-]{0,80}$/.test(kind)) throw new Error('Invalid review artifact kind.');
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new Error('Snapshot must be serializable JSON.');
  const hash = await digest(serialized);
  if (serialized.length > 4_000_000) throw new Error('The review process exceeds the snapshot budget; its complete current state remains available for export.');
  const snapshotId = crypto.randomUUID();
  const { snapshot: _snapshot, ...viewpoint } = context.viewpoint;
  const referenceContext: ReviewContext = { ...context, viewpoint };
  const save = async (id: string, payload: unknown) => {
    const row: ReviewFinding = { schemaVersion: 1, id, kind: 'note', text: JSON.stringify(payload), context: referenceContext,
      createdAt: instant(), ...(parentId ? { parentId } : {}) };
    const saved = await persist(row);
    if (saved !== id) throw new Error('The process snapshot was saved under an unexpected identity.');
    return saved;
  };
  if (serialized.length < 35_000) return save(snapshotId, { kind: `${kind}.snapshot`, schemaVersion: 1, sha256: hash, ...(kind === 'review.process' ? { process: value } : { value }) });
  const chunks: Array<{ id: string; sha256: string }> = [];
  for (let start = 0; start < serialized.length; start += 20_000) {
    const data = serialized.slice(start, start + 20_000), id = crypto.randomUUID(), sha256 = await digest(data);
    await save(id, { kind: `${kind}.chunk`, schemaVersion: 1, snapshotId, index: chunks.length, sha256, data });
    chunks.push({ id, sha256 });
  }
  return save(snapshotId, { kind: `${kind}.manifest`, schemaVersion: 1, sha256: hash, chunks });
}

/** Reopen only complete hash-matching snapshots; no partial run becomes success. */
export async function readReviewProcessSnapshot(snapshot: ReviewFinding, rows: readonly ReviewFinding[]): Promise<ReviewProcess> {
  const payload = JSON.parse(snapshot.text);
  if (payload?.schemaVersion !== 1) throw new Error('Unknown process snapshot version.');
  let serialized: string;
  if (payload.kind === 'review.process.snapshot') serialized = JSON.stringify(payload.process);
  else if (payload.kind === 'review.process.manifest' && Array.isArray(payload.chunks) && payload.chunks.length <= 200) {
    const parts: string[] = [];
    for (const [index, part] of payload.chunks.entries()) {
      const row = rows.find(row => row.id === part.id);
      if (!row || row.context.scopeId !== snapshot.context.scopeId) throw new Error('Process snapshot is missing a chunk in its model scope.');
      const chunk = JSON.parse(row.text);
      if (chunk.kind !== 'review.process.chunk' || chunk.snapshotId !== snapshot.id || chunk.index !== index || typeof chunk.data !== 'string'
          || chunk.sha256 !== part.sha256 || await digest(chunk.data) !== part.sha256) throw new Error('Process snapshot chunk integrity check failed.');
      parts.push(chunk.data);
    }
    serialized = parts.join('');
  } else throw new Error('This note is not a complete process snapshot.');
  if (serialized.length > 4_000_000 || await digest(serialized) !== payload.sha256) throw new Error('Process snapshot integrity check failed.');
  const checked = validateReviewProcess(JSON.parse(serialized));
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  if (checked.process.scopeId !== snapshot.context.scopeId) throw new Error('Process snapshot belongs to another model scope.');
  return checked.process;
}

export function useReviewProcessJournal(persist: (finding: ReviewFinding) => Promise<string>) {
  const [process, setProcess] = useState<ReviewProcess | null>(null);
  const [status, setStatus] = useState('No review process started');
  const live = useRef<ReviewProcess | null>(null);
  const context = useRef<ReviewContext | null>(null);
  const parent = useRef<string | undefined>(undefined);
  const persistLatest = useRef(persist); persistLatest.current = persist;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const bindings = useRef(new Map<string, string>());
  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const work = queue.current.then(operation); queue.current = work.catch(() => undefined); return work;
  }, []);
  const record = useCallback(async (value: ReviewProcess) => {
    live.current = value; setProcess(value);
    if (!context.current) throw new Error('The review has no captured input context.');
    try { await persistReviewProcessSnapshot(value, context.current, persistLatest.current, parent.current); }
    catch (error) { setStatus('Process snapshot not saved; current state remains available for export'); throw error; }
    setStatus(value.status === 'running' ? 'Review in progress' : `Review ${value.status}`);
    return value;
  }, []);
  const append = useCallback((event: ReviewProcessEvent) => enqueue(async () => {
    if (!live.current) throw new Error('Start a captured review process first.');
    return record(transitionReviewProcess(live.current, event));
  }), [enqueue, record]);
  const recover = useCallback((snapshot: ReviewFinding, rows: ReviewFinding[]) => enqueue(async () => {
    // A reload effect may race a newly requested run. Recovery never replaces
    // a process already established by begin() or an earlier recovery.
    if (live.current) return live.current;
    const recovered = await readReviewProcessSnapshot(snapshot, rows);
    if (live.current) return live.current;
    const inputId = snapshot.parentId ?? recovered.inspections[0]?.contextRef;
    const input = inputId ? rows.find(row => row.id === inputId && row.context.scopeId === recovered.scopeId) : undefined;
    context.current = structuredClone(input?.context ?? snapshot.context);
    parent.current = input?.id;
    bindings.current.clear();
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const child of rows) {
      if (child.kind !== 'candidate' || child.context.scopeId !== recovered.scopeId || child.context.elements.length !== 1) continue;
      let ancestor = child.parentId;
      const seen = new Set<string>();
      while (ancestor && !seen.has(ancestor) && seen.size < 100) {
        seen.add(ancestor);
        const original = recovered.findings.find(finding => finding.id === ancestor);
        if (original) {
          const element = child.context.elements[0], bound = original.element;
          if (bound && bound.modelId === element.modelId && bound.expressId === element.expressId && bound.ifcGlobalId === element.ifcGlobalId) bindings.current.set(child.id, original.id);
          break;
        }
        ancestor = byId.get(ancestor)?.parentId;
      }
    }
    if (recovered.status === 'running') return record(transitionReviewProcess(recovered, {
      kind: 'interrupt', at: instant(), reason: 'Viewer reloaded; incomplete run preserved without automatic continuation', evidenceRefs: [snapshot.id],
    }));
    live.current = recovered; setProcess(recovered); setStatus(`Recovered review ${recovered.status}`);
    return recovered;
  }), [enqueue, record]);
  const begin = useCallback((input: ReviewContext, prompt: string, parentId?: string) => enqueue(async () => {
    if (live.current?.status === 'running') throw new Error('Finish or interrupt the current review process before starting another.');
    context.current = structuredClone(input); parent.current = parentId; bindings.current.clear();
    const createdAt = instant();
    const initial = createReviewProcess({ id: crypto.randomUUID(), scopeId: input.scopeId, directive: prompt, models: input.models, createdAt });
    return record(transitionReviewProcess(initial, { kind: 'start', at: createdAt }));
  }), [enqueue, record]);
  const inspection = useCallback((input: ReviewContext, inputId: string, rawId: string, summary: string, model: string,
    candidates: Array<{ id: string; text: string }>) => enqueue(async () => {
    if (!live.current || input.scopeId !== live.current.scopeId) throw new Error('Inspection belongs to another review scope.');
    return record(transitionReviewProcess(live.current, { kind: 'inspection', at: instant(), inspection: {
      id: rawId, contextRef: inputId, viewpointId: input.viewpoint.guid, snapshotRef: `${inputId}#context.viewpoint.snapshot`, rawResponseRef: rawId, model, summary,
    }, findings: candidates.map(candidate => ({ id: candidate.id, text: candidate.text })) }));
  }), [enqueue, record]);
  const bind = useCallback((originalId: string, child: ReviewFinding) => enqueue(async () => {
    if (!live.current || child.context.scopeId !== live.current.scopeId || child.context.elements.length !== 1) throw new Error('An exact single element in the review scope is required.');
    const element = child.context.elements[0], source = child.context.models.find(source => source.id === element.modelId);
    if (!element.ifcGlobalId || !source) throw new Error('This element has no exact IFC identity or source revision.');
    const next = await record(transitionReviewProcess(live.current, { kind: 'bind', at: instant(), findingId: originalId,
      element: { ...element, ifcGlobalId: element.ifcGlobalId, sourceIdentity: source.sourceIdentity } }));
    bindings.current.set(child.id, originalId); return next;
  }), [enqueue, record]);
  const finish = useCallback((evidenceRefs: string[] = []) => enqueue(async () => {
    if (!live.current) throw new Error('No review process exists.');
    if (live.current.findings.some(finding => ['previewed', 'approved', 'applied'].includes(finding.status) || (finding.status === 'blocked' && finding.element && !finding.receipt))) {
      setStatus('Review awaits native human approval or native readback'); return live.current;
    }
    return record(transitionReviewProcess(live.current, { kind: 'finish', at: instant(), evidenceRefs }));
  }), [enqueue, record]);
  const fail = useCallback((reason: string, evidenceRefs: string[] = []) => append({ kind: 'fail', at: instant(), reason, evidenceRefs }), [append]);
  const interrupt = useCallback((reason: string, evidenceRefs: string[] = []) => append({ kind: 'interrupt', at: instant(), reason, evidenceRefs }), [append]);
  const canonicalFindingId = (id: string) => {
    const original = bindings.current.get(id) ?? id;
    return live.current?.findings.some(finding => finding.id === original) ? original : undefined;
  };
  return { process, status, schema: reviewProcessSchema, current: () => live.current, canonicalFindingId,
    originalFindingId: (id: string) => bindings.current.get(id) ?? id,
    begin, inspection, bind, append, recover, finish, fail, interrupt };
}
