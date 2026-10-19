/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { REVIEW_RESOLUTION_SCHEMA } from '@/lib/review-companion/resolution-schema';
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
    <p>Reopen a concern, inspect the actual model, repair supported defects and retain the original evidence.</p>
    <label className="block">Saved issue<select aria-label="Issue to investigate" className="w-full rounded border bg-background p-2" value={issue?.topicId ?? ''} onChange={e => setSelected(e.target.value)}>
      {!issue && <option value="">No saved BCF issues</option>}
      {review.resolution.issues.map(row => <option key={row.topicId} value={row.topicId}>{row.stage} · {row.title}</option>)}
    </select></label>
    {issue && <><p role="status">{issue.stage} · {issue.contextElementCount} surrounding elements</p>
      {issue.diagnosis && <p className="whitespace-pre-wrap">{issue.diagnosis}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
          await review.resolution.workflow.investigate(issue.topicId); await review.resolution.refresh(); review.setStatus('Saved issue restored with its original selection and viewpoint');
        })}>Reopen saved view</Button>
        <Button size="sm" disabled={!review.connection || review.busy} onClick={() => run(async () => {
          review.resolution.setActive(issue.topicId);
          const evidence = await review.prepareIssue(issue.topicId);
          await review.ask(`Continue issue ${issue.topicId}. Camera navigation and ONE visual inspection have already executed and are saved. Do not repeat image inspection or camera actions before repair. Here is exact source geometry evidence: ${JSON.stringify(evidence)}. You are authorized to fix one supported defect here. If a report contains a candidateId and defective faces, create a BCF subissue titled Mesh integrity: from that candidate, then apply remove_defective_faces to one reported defective meshPath using its modelId and sourceHash. Use the actual returned receiptRef and verificationRef to mark only that mesh subissue fixed. Counts overlap: report the difference in before/after face totals, never add degenerate and duplicate counts. Keep the original architectural concern open unless separately verified. If no measured defect supports repair, use the installed native tools for further diagnosis and record the precise missing evidence. Finish after one verified repair or a precise blocker.`);
          await review.inspect(undefined, undefined, 'Describe the current scene after the investigation and any applied repair. Do not claim mesh integrity or architectural acceptance from the image. Preserve this actual viewpoint as after-state evidence.');
          await review.resolution.refresh();
        })}>Investigate &amp; fix supported defects</Button>
      </div>
      <p className="text-muted-foreground">Original images stay unchanged. Repairs keep both source revisions and an Undo receipt. Unresolved architectural questions stay open.</p>
    </>}
    {review.resolution.repairs.map(repair => <div key={repair.receiptRef} className="rounded border p-2 space-y-2">
      <strong>Saved geometry repair · {repair.modelName}</strong>
      {repair.before && repair.after && <p>Faces: {repair.before.faceCount} → {repair.after.faceCount}</p>}
      <div className="flex flex-wrap gap-2">{([['Resume repaired model', 'review_geometry_resume'], ['Undo this repair', 'review_geometry_undo']] as const).map(([label, name]) => <Button key={name} size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
        const result = await review.resolution.tools.find(t => t.name === name)!.execute({ receiptRef: repair.receiptRef }); review.setStatus(JSON.stringify(result)); await review.resolution.refresh();
      })}>{label}</Button>)}</div>
    </div>)}
    <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
      const tools = review.resolution.tools.find(t => t.name === 'review_native_tools')!;
      const result = await tools.execute({}); review.setStatus(JSON.stringify(result));
    })}>Show available native tools</Button>
  </section>;
}
