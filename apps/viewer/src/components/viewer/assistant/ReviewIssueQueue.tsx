/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { REVIEW_RESOLUTION_SCHEMA } from '@/lib/review-companion/resolution-schema';
import { investigateSavedIssue } from '@/lib/review-companion/issue-investigation';
import { recheckSavedConcern } from '@/lib/review-companion/issue-recheck';
import { downloadBlob } from '@/lib/export/download';
import { Button } from '@/components/ui/button';
import type { useReviewCompanion } from '@/hooks/useReviewCompanion';
type Review = ReturnType<typeof useReviewCompanion>;
export function ReviewIssueQueue({ review, run }: { review: Review; run(action: () => Promise<unknown>): void }) {
  const [selected, setSelected] = useState('');
  const [nextAction, setNextAction] = useState('');
  const issue = review.resolution.issues.find(row => row.topicId === selected) ?? review.resolution.issues[0];
  return <section className="rounded border border-primary p-3 space-y-2" aria-label="Saved issue work queue">
    <strong>Saved issue work queue · {review.resolution.issues.length}</strong>
    <Button size="sm" variant="outline" onClick={() => downloadBlob(new Blob([JSON.stringify(REVIEW_RESOLUTION_SCHEMA, null, 2)], { type: 'application/schema+json' }), 'ifc-review-resolution.schema.json')}>Export resolution schema</Button>
    <p>Use the saved BCF evidence. Take one action, record its result, then continue toward a verified fix.</p>
    <label className="block">Saved issue<select aria-label="Issue to investigate" className="w-full rounded border bg-background p-2" value={issue?.topicId ?? ''} onChange={e => { setSelected(e.target.value); setNextAction(''); }}>
      {!issue && <option value="">No saved BCF issues</option>}
      {review.resolution.issues.map(row => <option key={row.topicId} value={row.topicId}>{row.stage} · {row.title}</option>)}
    </select></label>
    {issue && <><p role="status">{issue.stage} · {issue.contextElementCount} surrounding elements</p>
      {issue.diagnosis && <p className="whitespace-pre-wrap">{issue.diagnosis}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
          await review.resolution.workflow.open(issue.topicId); await review.resolution.refresh(); review.setStatus('Saved view restored; issue status preserved');
        })}>Reopen saved view</Button>
        <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
          await review.resolution.saveView(issue.topicId, 'Current issue view saved by the owner. This image is an observation, not independent architectural acceptance.');
          review.setStatus('Current image and camera saved on this issue');
        })}>Save current issue view</Button>
        <Button size="sm" disabled={!review.connection || review.busy} onClick={() => run(async () => {
          review.resolution.setActive(issue.topicId);
          const result = await investigateSavedIssue({ workflow: review.resolution.workflow, prepare: review.prepareIssue, ask: review.ask }, issue.topicId);
          review.setStatus(`Issue ${result.stage}: ${result.diagnosis}`);
          await review.resolution.refresh();
        })}>Run next issue step</Button>
        <Button size="sm" variant="outline" disabled={!review.connection || review.busy || issue.stage === 'fixed'} onClick={() => run(async () => {
          review.resolution.setActive(issue.topicId);
          const result = await recheckSavedConcern({ workflow: review.resolution.workflow, inspect: input => review.inspectConcern(input) }, issue.topicId);
          await review.resolution.refresh(); review.setStatus(`Saved issue rechecked: ${result.summary}`);
        })}>Recheck this issue in current view</Button>
      </div>
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); const action = nextAction; run(async () => {
        review.resolution.setActive(issue.topicId);
        const result = await investigateSavedIssue({ workflow: review.resolution.workflow, prepare: review.prepareIssue, ask: review.ask }, issue.topicId, action);
        await review.resolution.refresh(); review.setStatus(`Issue ${result.stage}: ${result.diagnosis}`);
        setNextAction(current => current === action ? '' : current);
      }); }}>
        <label className="block">One next action for this issue<textarea aria-label="One next action for this issue" maxLength={2000} rows={2} value={nextAction} onChange={event => setNextAction(event.target.value)} placeholder="For example: measure the roof-to-wall clearance at the saved corner." className="w-full rounded border bg-background p-2" /></label>
        <Button size="sm" variant="outline" type="submit" disabled={!review.connection || review.busy || !nextAction.trim()}>Run this issue action</Button>
        <p className="text-muted-foreground">Restores this issue’s saved view, takes one action, then records its result. Other issues and history are excluded.</p>
      </form>
      <label className="block">Import geometry repair plan<input aria-label="Import geometry repair plan" type="file" accept="application/json,.json" disabled={review.busy} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) run(async () => { const plan = await review.resolution.importPlan(issue.topicId, file); review.setStatus(`Geometry plan saved: ${plan.planRef}. Faces ${plan.beforeFaces} → ${plan.afterFaces}. Ready for Bonsai to apply; no model change yet.`); });
      }} /></label>
      <p className="text-muted-foreground">Original images stay unchanged. Repairs keep both source revisions and an Undo receipt. Unresolved architectural questions stay open.</p>
    </>}
    {review.resolution.repairs.map(repair => <div key={repair.receiptRef} className="rounded border p-2 space-y-2">
      <strong>Saved geometry repair · {repair.modelName}</strong>
      {repair.before && repair.after && <p>Faces: {repair.before.faceCount} → {repair.after.faceCount}</p>}
      <div className="flex flex-wrap gap-2">{([['Resume repaired model', 'review_geometry_resume'], ['Undo this repair', 'review_geometry_undo']] as const).map(([label, name]) => <Button key={name} size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
        await review.resolution.tools.find(t => t.name === name)!.execute({ receiptRef: repair.receiptRef }); review.setStatus(name === 'review_geometry_resume' ? 'Repaired model restored and source verified' : 'Original model restored; repair undone and issue reopened'); await review.resolution.refresh();
      })}>{label}</Button>)}<Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
        await review.resolution.saveRepairView(repair.receiptRef); review.setStatus('Repaired image and camera saved with matching source and application');
      })}>Save repaired view</Button></div>
    </div>)}
    <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
      const tools = review.resolution.tools.find(t => t.name === 'review_native_tools')!;
      const result = await tools.execute({}); review.setStatus(JSON.stringify(result));
    })}>Show available native tools</Button>
  </section>;
}
