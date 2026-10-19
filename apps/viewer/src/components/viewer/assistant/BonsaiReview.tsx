/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { ReviewIssueQueue } from './ReviewIssueQueue';
import { ReviewPropertyChanges } from './ReviewPropertyChanges';
import { useReviewCompanion } from '@/hooks/useReviewCompanion';
import { MAX_RESOLUTION_BACKUP_BYTES } from '@/lib/review-companion/resolution-archive';
import { runReviewAction, useReviewActionState, ReviewActionBusyError } from '@/lib/review-companion/action-gate';

export function BonsaiReview({ active }: { active: boolean }) {
  const companion = useReviewCompanion(active);
  const [backupParts, setBackupParts] = useState<Array<{ blob: Blob; filename: string }>>([]);
  const actionBusy = useReviewActionState(s => s.busy);
  const actionError = useReviewActionState(s => s.error);
  const review = { ...companion, busy: companion.busy || actionBusy, error: companion.error || actionError };
  const fastActivity = review.fast.events();
  const activity = (fastActivity[0]?.timestamp ?? 0) > (review.activity[0]?.timestamp ?? 0) ? fastActivity : review.activity;
  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [focus, setFocus] = useState(review.directive);
  const file = useRef<HTMLInputElement>(null);
  const run = (operation: () => Promise<unknown>) => {
    review.setError('');
    void runReviewAction(operation).catch(error => {
      if (error instanceof ReviewActionBusyError) return;
      const text = error instanceof Error ? error.message : String(error);
      if (/aborted|aborterror/i.test(text)) { review.setStatus('Review paused; saved observations are preserved'); review.setError(''); }
      else { review.setStatus('Action stopped; see the explanation below. Saved observations are preserved.'); review.setError(text); }
    });
  };
  return <div hidden={!active} className="flex-1 min-h-0 overflow-auto p-3 space-y-3 text-xs" aria-label="Bonsai visual review">
    <p>Review the building together. Notes and possible issues keep their image, element references and viewpoint.</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(review.connect)}>{review.connection ? 'Reconnect Bonsai' : 'Connect Bonsai vision'}</Button>
      <Button size="sm" variant="outline" disabled={!review.scope || review.busy} onClick={() => run(review.dictation)} aria-pressed={review.listening}>{review.listening ? 'Stop dictation' : 'Start local dictation'}</Button>
    </div>
    <p role="status" aria-live="polite" className="text-muted-foreground break-words">{review.status}</p>
    {actionBusy && !companion.busy && <p role="status">Review action in progress; waiting for its saved result.</p>}
    <p className="text-muted-foreground">{review.webMcp}. Images go to Bonsai on this computer. Dictation uses the browser’s on-device speech pack.</p>
    {review.error && <p role="alert" className="rounded border border-destructive p-2 whitespace-pre-wrap">{review.error}</p>}
    <ReviewIssueQueue review={review} run={run} />
    <section className="rounded border border-primary p-3 space-y-2" aria-label="Selected-region issue mission">
      <p role="status">{review.busy ? 'Working — your captured view is being reviewed' : review.connection && review.scope ? 'Ready — select surrounding elements and frame the concern' : 'Connect Bonsai and load a model to begin'}</p>
      <p>A hole or missing piece need not be selectable. Select what surrounds it, or use the viewpoint alone.</p>
      <Button disabled={!review.connection || !review.scope || review.busy} onClick={() => run(() => review.reviewHere(text.trim() || focus))}>Describe &amp; log BCF issue</Button>
      <Button variant="outline" disabled={review.busy} onClick={() => run(async () => {
        const issues = await review.bcf.list();
        if (!issues.length) { review.setStatus('No BCF issues saved for this model yet'); return; }
        await review.bcf.open(issues.at(-1)!.topicId);
        const { useViewerStore } = await import('@/store'); useViewerStore.getState().setBcfPanelVisible(true);
      })}>Open latest BCF issue</Button>
    </section>
    <label className="block space-y-1">Review focus
      <textarea rows={2} maxLength={8000} value={focus} onChange={e => { setFocus(e.target.value); review.setDirective({ mode: review.mode, directive: e.target.value }); }} className="w-full rounded border bg-background p-2" />
    </label>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={!review.connection || !review.scope || review.busy} onClick={() => run(review.inspect)}>Inspect this view</Button>
      <Button size="sm" variant="outline" disabled={!review.connection || !review.scope || review.busy} aria-pressed={review.mode === 'observe'}
        onClick={() => { try { review.setDirective({ mode: review.mode === 'observe' ? 'paused' : 'observe', directive: focus }); } catch (e) { review.setError(String(e)); } }}>
        {review.mode === 'observe' ? 'Pause watching' : 'Watch as I explore'}
      </Button>
      {companion.busy && <Button size="sm" variant="outline" onClick={review.cancel}>Stop</Button>}
    </div>
    <div className="rounded border p-2 space-y-2" aria-label="Fast visible tour">
      <p>Fast tour visits distinct angles once, with 350 ms camera transitions. Bonsai analyses the captured stops separately. Analysis can take tens of seconds per view.</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!review.connection || !review.scope || review.busy} onClick={() => run(review.fast.start)}>Start fast visible tour</Button>
      <Button size="sm" variant="outline" disabled={!review.scope || review.busy} onClick={() => run(review.fast.addStop)}>Add current view to tour</Button></div>
      <p role="status">{review.fast.status} · {review.fast.completed} analysed · {review.fast.pending} pending · {review.fast.stops} saved stops</p>
      <p className="text-muted-foreground">For inside and outside: visit each view and add it as a stop. Stop halts movement and analysis.</p>
    </div>
    <p className="text-muted-foreground">Watching checks changed views at most every 12 seconds, one review at a time. Suggestions need your review.</p>
    <form onSubmit={e => { e.preventDefault(); const original = text; run(async () => { await review.note(original); setText(current => current === original ? '' : current); }); }} className="space-y-2">
      <label className="block space-y-1">Your observation
        <textarea rows={2} maxLength={8000} value={text} onChange={e => setText(e.target.value)} placeholder="Select an element, then describe what you notice…" className="w-full rounded border bg-background p-2" />
      </label>
      <Button size="sm" type="submit" variant="outline" disabled={!text.trim() || !review.scope}>Save note with this view</Button>
    </form>
    <form onSubmit={e => { e.preventDefault(); const prompt = instruction; run(async () => { await review.ask(prompt); setInstruction(current => current === prompt ? '' : current); }); }} className="space-y-2 border-t pt-3">
      <label className="block space-y-1">Ask Bonsai to help
        <textarea rows={2} maxLength={8000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="For example: frame my selection and inspect it, then save what you notice." className="w-full rounded border bg-background p-2" />
      </label>
      <Button size="sm" variant="outline" type="submit" disabled={!review.connection || !instruction.trim() || review.busy}>Run directive</Button>
    </form>
    <Button size="sm" variant="outline" disabled={!review.connection || !review.scope || review.busy} onClick={() => run(() => review.ask('Visibly rotate and zoom to inspect several sides of the model. Find up to five distinct candidate issues, stopping earlier if evidence is insufficient. Use review_inspect after moving and log the actual observations. Bind each visual candidate to an element using its image location when possible. Read the exact IFC data for bound elements. Propose only supported property corrections with evidence for the replacement value, using native previews; otherwise explain what measurement or authoring work is needed. Leave all corrections awaiting owner review and leave automatic observation paused.'))}>Explore and review up to five issues</Button>
    <section className="space-y-2 border-t pt-3" aria-label="Review process">
      <p role="status">{review.process.status}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => downloadBlob(new Blob([JSON.stringify(review.process.schema, null, 2)], { type: 'application/schema+json' }), 'ifc-review-process.schema.json')}>Export process schema</Button>
        <Button size="sm" variant="outline" disabled={!review.process.process} onClick={() => downloadBlob(new Blob([JSON.stringify(review.process.process, null, 2)], { type: 'application/json' }), `ifc-review-process-${review.process.process!.id}.json`)}>Export current process</Button>
        <Button size="sm" variant="outline" disabled={!activity.length} onClick={() => downloadBlob(new Blob([JSON.stringify(activity, null, 2)], { type: 'application/json' }), 'ifc-review-ag-ui-events.json')}>Export activity events</Button>
      </div>
      <ol aria-label="Bonsai live actions" className="space-y-1">{activity.filter(e => e.type === 'TOOL_CALL_START' || e.type === 'TOOL_CALL_RESULT' || e.type === 'RUN_ERROR' || e.type === 'RUN_FINISHED').slice(-10).map((event, index) => <li key={`${event.timestamp}-${index}`}>{event.type === 'TOOL_CALL_START' ? `Started: ${event.toolCallName}` : event.type === 'TOOL_CALL_RESULT' ? 'Action returned; result recorded' : event.type === 'RUN_ERROR' ? event.message : 'Directive finished'}</li>)}</ol>
    </section>
    <ReviewPropertyChanges properties={review.properties} run={run} busy={review.busy} />
    {review.pending.length > 0 && <div role="alert" className="rounded border border-destructive p-2 space-y-2">
      <p>{review.pending.length} record(s) are not saved. Keep this panel open until retry or export succeeds.</p>
      <Button size="sm" disabled={review.busy} onClick={() => run(review.retryPending)}>Retry saving</Button>
      <Button size="sm" variant="outline" onClick={() => downloadBlob(new Blob([JSON.stringify(review.pending, null, 2)], { type: 'application/json' }), `unsaved-review-${crypto.randomUUID()}.json`)}>Export unsaved records</Button>
    </div>}
    <div className="border-t pt-3 space-y-2">
      <label className="block space-y-1">Saved reviews
        <select disabled={review.busy} value={review.historyScope} onChange={e => review.setHistoryScope(e.target.value)} className="w-full rounded border bg-background p-2">
          <option value="">Current model revision</option>
          {review.scopes.filter(s => s.scopeId !== review.scope).map(s => <option key={s.scopeId} value={s.scopeId}>{s.models.slice(0, 2).map(m => m.name).join(', ')}{s.models.length > 2 ? ` + ${s.models.length - 2} sources` : ''} · {s.count} records · {s.scopeId.slice(-8)}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={review.busy || !review.findings.length && !review.resolution.issues.length} onClick={() => run(async () => {
          const archives = await review.exportBackupParts();
          const stem = sanitizeFilename(`building-review-${new Date().toISOString().replaceAll(':', '-')}`);
          const parts = archives.map((blob, index) => ({ blob, filename: `${stem}${archives.length > 1 ? `-part-${index + 1}-of-${archives.length}` : ''}.json` }));
          setBackupParts(parts);
          if (parts.length === 1) { downloadBlob(parts[0].blob, parts[0].filename); review.setStatus('Backup exported; keep it with your project files'); }
          else review.setStatus(`Backup prepared in ${parts.length} parts. Download every part below and keep them together. Import every part to restore the complete repair history.`);
        })}>Export backup</Button>
        {backupParts.length > 1 && backupParts.map((part, index) => <Button key={part.filename} size="sm" variant="outline" onClick={() => downloadBlob(part.blob, part.filename)}>Download backup part {index + 1} of {backupParts.length}</Button>)}
        <Button size="sm" variant="outline" disabled={review.busy} onClick={() => file.current?.click()}>Import backup</Button>
        <input ref={file} type="file" accept=".json,application/json" className="hidden" onChange={e => { const selected = e.target.files?.[0]; e.target.value = ''; if (selected) run(async () => {
          if (selected.size > MAX_RESOLUTION_BACKUP_BYTES) throw new Error('This backup is too large to import (256 MiB maximum).');
          const imported = await review.importArchive(JSON.parse(await selected.text())); review.setStatus(`Imported ${imported.findingsAdded} records`);
        }); }} />
        <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
          const granted = await navigator.storage?.persist(); review.setStatus(granted ? 'Browser persistent storage granted. Keep an exported backup too.' : 'Browser persistence was not granted. Export a backup to keep your notes.');
        })}>Keep notes on this device</Button>
      </div>
    </div>
    <ol className="space-y-3">
      {review.findings.filter(f => !f.text.startsWith('{"kind":"review.geometry.source.chunk"')).map(finding => {
        const state = review.events.filter(e => e.findingId === finding.id).at(-1)?.status ?? (finding.kind === 'candidate' ? 'needs review' : 'note');
        return <li key={finding.id} className="rounded border p-2 space-y-2">
          <div className="flex justify-between gap-2"><strong>{finding.kind === 'candidate' ? `Possible issue · ${state}` : finding.provider ? 'Bonsai response' : finding.text.startsWith('{') ? 'Recorded process / activity' : 'Your note / review input'}</strong><time dateTime={finding.createdAt}>{new Date(finding.createdAt).toLocaleTimeString()}</time></div>
          {finding.provider || finding.text.startsWith('{') ? <details open={finding.kind === 'candidate'}><summary>{finding.kind === 'candidate' ? 'Observation' : 'Recorded response'}</summary><p className="whitespace-pre-wrap break-words">{finding.text}</p></details> : <p className="whitespace-pre-wrap break-words">{finding.text}</p>}
          <p className="text-muted-foreground">{finding.context.elements.length ? finding.context.elements.map(e => `${finding.context.models.find(m => m.id === e.modelId)?.name ?? e.modelId} · #${e.expressId}${e.ifcGlobalId ? ` · ${e.ifcGlobalId}` : ''}`).join('; ') : 'Viewpoint only; no exact element identified'}</p>
          {finding.context.models.some(m => m.sourceIdentity.startsWith('session:')) && <p className="text-muted-foreground">Source identity is limited to this load session. This note remains available in saved reviews.</p>}
          <details><summary>Saved image</summary>{finding.context.viewpoint.snapshot && <img src={finding.context.viewpoint.snapshot} alt="Building view captured with this observation" className="w-full rounded" loading="lazy" />}</details>
          <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(() => review.restore(finding.id))}>Return to view</Button>
          {finding.kind === 'candidate' && <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(async () => {
            const result = await review.bcf.create({ findingId: finding.id, title: `Review: ${finding.text}`.slice(0, 180), description: finding.text.slice(0, 4000) });
            review.setStatus(`BCF issue saved: ${result.title}`);
          })}>Create BCF issue</Button>}
          {finding.location && <Button size="sm" variant="outline" disabled={review.busy} onClick={() => run(() => review.pickFinding(finding.id))}>Select element at this image location</Button>}
          {finding.kind === 'candidate' && <div className="flex flex-wrap gap-1">{(['confirmed', 'dismissed', 'resolved'] as const).map(status => <Button key={status} size="sm" variant="outline" disabled={review.busy} onClick={() => run(() => review.setFindingStatus(finding.id, status))}>{status === 'confirmed' ? 'Confirm issue' : status === 'dismissed' ? 'Dismiss' : 'Mark resolved'}</Button>)}</div>}
        </li>;
      })}
    </ol>
    {!review.findings.length && <p className="text-muted-foreground">No saved observations in this review yet.</p>}
  </div>;
}
