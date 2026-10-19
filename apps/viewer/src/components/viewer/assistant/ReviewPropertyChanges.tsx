/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import type { useReviewPropertyTools } from '@/hooks/useReviewPropertyTools';
import { changeField } from '@/lib/actions/model-change-commit';

type Properties = ReturnType<typeof useReviewPropertyTools>;
export function ReviewPropertyChanges({ properties, run, busy = false }: { properties: Properties; run(operation: () => Promise<unknown>): void; busy?: boolean }) {
  const editEnabled = useViewerStore(s => s.editEnabled);
  const [undone, setUndone] = useState<Set<string>>(new Set());
  return <section aria-label="Proposed IFC corrections" className="space-y-2">
    <p className="text-muted-foreground">IFC data corrections use a reviewed before-and-after preview. Geometry changes require the native authoring path and supported measurements.</p>
    {!editEnabled && <Button size="sm" variant="outline" disabled={busy} onClick={() => useViewerStore.getState().setEditEnabled(true)}>Turn on IFC editing</Button>}
    {properties.proposals.map(proposal => {
      const outcome = properties.outcomes.filter(o => o.previewId === proposal.id).at(-1)?.result;
      const receipt = outcome && 'receipt' in outcome ? outcome.receipt : undefined;
      return <div key={proposal.id} className="rounded border p-2 space-y-2">
        <strong>{proposal.batch.title}</strong>
        <p>{proposal.batch.rationale}</p>
        <ul>{proposal.preview.rows.map(row => <li key={row.index} className="py-1 break-words">
          {row.change.target.globalId} · {changeField(row.change)}<br />
          {JSON.stringify(row.current)} → {JSON.stringify(row.change.op === 'property.delete' ? null : row.change.value)} · {row.status}
          {row.denial && <p>{row.denial}</p>}
        </li>)}</ul>
        {!receipt && <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => properties.refresh(proposal))}>Refresh preview</Button>
          <Button size="sm" disabled={busy || !editEnabled || proposal.preview.rows.some(r => r.status !== 'ready')} onClick={() => run(() => properties.apply(proposal))}>Approve and apply these values</Button>
        </div>}
        {outcome && <p role="status" className="break-words">{'applied' in outcome && outcome.applied ? outcome.ok ? 'Applied; effective IFC values read back and receipt saved.' : 'Values changed, but verification or receipt persistence failed. Review the recorded result.' : `Apply refused: ${'reason' in outcome ? outcome.reason : 'not applied'}`}</p>}
        {receipt && <details><summary>Actual transaction and readback</summary><pre className="whitespace-pre-wrap break-words">{JSON.stringify(outcome, null, 2)}</pre></details>}
        {receipt && !undone.has(receipt.id) && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
          const result = await properties.undo(proposal, receipt.id);
          if (result.ok) setUndone(ids => new Set([...ids, receipt.id]));
          else throw new Error(`Undo refused: ${'reason' in result ? result.reason : 'receipt was not saved'}`);
        })}>Undo this correction</Button>}
        {receipt && undone.has(receipt.id) && <p>Correction undone through native edit history.</p>}
      </div>;
    })}
  </section>;
}
