/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
interface SavedIssue { topicId: string; title?: string }
export interface IssuePreparationOptions {
  workflow: { list(): Promise<SavedIssue[]>; investigate(topicId: string): Promise<unknown> };
  inspect(signal: AbortSignal, instruction: string): Promise<{ summary: string; findings: Array<{ id: string }> }>;
  onStatus(text: string): void;
}
export interface PreparedIssueReport { summary: string; evidenceRefs: string[] }
/** Open one BCF concern and ask one visual question. Exact evidence is pulled on demand. */
export async function prepareSavedIssue(options: IssuePreparationOptions, topicId: string, signal: AbortSignal): Promise<PreparedIssueReport> {
  signal.throwIfAborted();
  const issue = (await options.workflow.list()).find(row => row.topicId === topicId);
  signal.throwIfAborted();
  if (!issue) throw new Error('Saved issue not found.');
  await options.workflow.investigate(topicId); signal.throwIfAborted();
  // Inspect the saved view before any orbit: BCF does not retain its original orbit pivot.
  const result = await options.inspect(signal, `Look only at this saved concern: ${issue.title ?? topicId}. What visible fact supports or contradicts this concern? State uncertainty. Do not search for other issues or infer corrective dimensions.`);
  signal.throwIfAborted();
  options.onStatus('Saved concern inspected. Bonsai will request only the next piece of evidence it needs.');
  return { summary: result.summary, evidenceRefs: result.findings.map(finding => finding.id) };
}
