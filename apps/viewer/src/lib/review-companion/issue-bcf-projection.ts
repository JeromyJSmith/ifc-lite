/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { BCFComment } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import { readIssueWorkflowEvent } from './issue-workflow';
import type { ReviewFinding } from './types';

/** Project saved diagnoses, never fabricate a new review or repair receipt.
 * Reopening/retrying uses the durable event ID as the BCF comment identity. */
export function projectIssueWorkflowToBcf(topicId: string, scopeId: string, rows: ReviewFinding[]) {
  const records = rows.flatMap(row => {
    const value = row.context.scopeId === scopeId ? readIssueWorkflowEvent(row) : null;
    return value?.topicId === topicId ? [{ row, value }] : [];
  }).sort((a, b) => Date.parse(a.value.createdAt) - Date.parse(b.value.createdAt));
  const topic = () => useViewerStore.getState().bcfProject?.topics.get(topicId);
  if (!topic()) throw new Error('The native BCF topic is unavailable for its saved workflow projection.');
  for (const { row, value } of records) {
    // Preparation restates the prior diagnosis; it is not another observation.
    if (value.stage === 'investigating') continue;
    const refs = [...new Set([...value.evidenceRefs, value.mutationReceiptRef, value.verificationRef].filter(Boolean))];
    const comment: BCFComment = { guid: row.id, date: value.createdAt, author: 'IFC-Lite review workflow',
      comment: [`Saved issue outcome: ${value.stage}`, `Recorded diagnosis:\n${value.diagnosis}`,
        ...(value.visualObservation ? [`Recorded visual observation:\n${value.visualObservation}`] : []),
        ...(refs.length ? [`Evidence records:\n${refs.join('\n')}`] : []), `Workflow record: ${row.id}`].join('\n\n') };
    const existing = topic()!.comments.filter(item => item.guid === row.id);
    if (existing.length > 1 || existing.some(item => item.comment !== comment.comment || item.date !== comment.date || item.author !== comment.author))
      throw new Error('An existing BCF comment conflicts with this saved workflow record; both records are preserved.');
    if (!existing.length) useViewerStore.getState().addComment(topicId, comment);
    const actual = topic()?.comments.filter(item => item.guid === row.id);
    if (actual?.length !== 1 || actual[0].comment !== comment.comment) throw new Error('The native BCF diagnosis comment did not persist in the topic.');
  }
  const latest = records.at(-1)?.value;
  if (latest) {
    const status = latest.stage === 'fixed' ? 'Resolved' : latest.stage === 'dismissed' ? 'Closed' : 'Open';
    useViewerStore.getState().updateTopic(topicId, { topicStatus: status });
    if (topic()?.topicStatus !== status) throw new Error('Native BCF status readback differs from its saved workflow.');
  }
  return { topicId, status: topic()!.topicStatus, projectedRecords: records.length };
}
