/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { REVIEW_RESOLUTION_SCHEMA } from '@/lib/review-companion/resolution-schema';
import { investigateSavedIssue } from '@/lib/review-companion/issue-investigation';
import { downloadBlob } from '@/lib/export/download';
import { Button } from '@/components/ui/button';
import type { useReviewCompanion } from '@/hooks/useReviewCompanion';
type Review = ReturnType<typeof useReviewCompanion>;
export function ReviewIssueQueue({ review, run }: { review: Review; run(action: () => Promise<unknown>): void }) {
  const [selected, setSelected] = useState('');
  const issue = review.resolution.issues.find(row => row.topicId === selected) ?? review.resolution.issues[0];
  return <section className="rounded border border-primary p-3 space-y-2" aria-label="Saved issue work queue">
    <strong>Saved issue work queue · {review.resolution.issues.length}</strong>
    <Button size="sm" variant="outline" onClick={() => downloadBlob(new Blob([JSON.stringify(REVIEW_RESOLUTION_SCHEMA, null, 2)], { type: 'application/schema+json' }), 'ifc-review-resolution.schema.json')}>Export resolution schema</Button>
    <p>Use the saved BCF evidence. Take one action, record its result, then continue toward a verified fix.</p>
    <label className="block">Saved issue<select aria-label="Issue to investigate" className="w-full rounded border bg-background p-2" value={issue?.topicId ?? ''} onChange={e => setSelected(e.target.value)}>
      {!issue && <option value="">No saved BCF issues</option>}
      {review.resolution.issues.map(row => <option key={row.topicId} value={row.topicId}>{row.stage} · {row.title}</option>)}
    </select></label>
    {issue && <><p role="status">{issue.stage} · {issue.contextElementCount} surrounding elements</p>
      {issue.diagnosis && <p className="whitespace-pre-wrap">{issue.diagnosis}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
          await review.resolution.workflow.open(issue.topicId); await review.resolution.refresh(); review.setStatus('Saved view restored; issue status preserved');
        })}>Reopen saved view</Button>
        <Button size="sm" disabled={!review.connection || review.busy} onClick={() => run(async () => {
          review.resolution.setActive(issue.topicId);
          const result = await investigateSavedIssue({ workflow: review.resolution.workflow, prepare: review.prepareIssue, ask: review.ask }, issue.topicId);
          review.setStatus(`Issue ${result.stage}: ${result.diagnosis}`);
          await review.resolution.refresh();
        })}>Run next issue step</Button>
      </div>
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
      })}>{label}</Button>)}</div>
    </div>)}
    <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
      const tools = review.resolution.tools.find(t => t.name === 'review_native_tools')!;
      const result = await tools.execute({}); review.setStatus(JSON.stringify(result));
    })}>Show available native tools</Button>
  </section>;
}
