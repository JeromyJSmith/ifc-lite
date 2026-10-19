/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { createIssueWorkflow } from './issue-workflow';
type Workflow = ReturnType<typeof createIssueWorkflow>;

/** Direct current-view inference: no tool-selection round trip and no camera restoration. */
export async function recheckSavedConcern(options: {
  workflow: Pick<Workflow, 'list' | 'record'>;
  inspect(input: { topicId: string; question: string }): Promise<unknown>;
}, topicId: string) {
  const issue = (await options.workflow.list()).find(row => row.topicId === topicId);
  if (!issue) throw new Error('Saved issue not found.');
  if (issue.stage === 'fixed') throw new Error('This issue is already fixed. Reopen it before requesting another concern check.');
  const result = await options.inspect({ topicId, question: 'In this current view, is the saved concern still visible? Describe one specific remaining geometric condition, if any. Distinguish selection outlines, shading and separate board faces from a physical gap or overlap. A visual suspicion is not a confirmed defect. Do not search for other issues.' });
  if (!result || typeof result !== 'object' || !('summary' in result) || typeof result.summary !== 'string'
    || !('evidenceRefs' in result) || !Array.isArray(result.evidenceRefs) || result.evidenceRefs.length < 2
    || !result.evidenceRefs.every(ref => typeof ref === 'string' && ref.length > 0)) throw new Error('Visual check did not return persisted input and response evidence. Issue status was preserved.');
  const current = (await options.workflow.list()).find(row => row.topicId === topicId);
  if (!current || current.workflowRef !== issue.workflowRef) throw new Error('Issue changed during visual review. The captured evidence is preserved; its newer disposition was not overwritten.');
  const evidenceRefs = [...new Set([...result.evidenceRefs, ...issue.evidenceRefs])].slice(0, 100);
  await options.workflow.record({ topicId, stage: 'needs-evidence',
    diagnosis: `Current-view visual recheck: ${result.summary}. This is visual evidence; native geometry and issue-specific verification determine whether a repair is needed.`.slice(0, 8000), evidenceRefs });
  return { summary: result.summary, evidenceRefs };
}
