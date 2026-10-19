/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
interface SavedIssue { topicId: string; title: string; definitionRef: string; findingId: string }
export interface IssuePreparationOptions {
  workflow: { list(): Promise<SavedIssue[]>; investigate(topicId: string): Promise<unknown> };
  onStatus(text: string): void;
}
export interface PreparedIssueReport { summary: string; evidenceRefs: string[] }
/** Reuse the saved BCF observation. A fresh image is a requested step, not a preload. */
export async function prepareSavedIssue(options: IssuePreparationOptions, topicId: string, signal: AbortSignal): Promise<PreparedIssueReport> {
  signal.throwIfAborted();
  const issue = (await options.workflow.list()).find(row => row.topicId === topicId);
  signal.throwIfAborted();
  if (!issue) throw new Error('Saved issue not found.');
  await options.workflow.investigate(topicId); signal.throwIfAborted();
  options.onStatus('Saved BCF view restored. Bonsai will request one next piece of evidence.');
  return { summary: issue.title, evidenceRefs: [...new Set([issue.definitionRef, issue.findingId])] };
}
