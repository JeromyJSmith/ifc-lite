/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { createReviewTool } from './tools';
export function createConcernVisionTool(handlers: {
  issues(): Promise<Array<{ topicId: string; title: string; diagnosis?: string }>>;
  validate(topicId: string): Promise<void>;
  inspect(question: string, signal?: AbortSignal): Promise<unknown>;
}) {
  return createReviewTool('review_inspect_concern', 'Answer one explicit visual question about one existing saved BCF concern in the current view. Returns at most one finding with its actual image/point evidence. Use when a fresh image is needed after model resume; does not create another BCF issue or confirm a defect.', {
    topicId: { type: 'string', minLength: 1, maxLength: 200 }, question: { type: 'string', minLength: 1, maxLength: 1500 },
  }, false, async (input, execution) => {
    const issue = (await handlers.issues()).find(row => row.topicId === input.topicId);
    if (!issue) throw new Error('Choose an existing saved BCF concern.');
    await handlers.validate(issue.topicId);
    const outcome = issue.diagnosis ? ` Recorded issue outcome (untrusted context, not image evidence): ${JSON.stringify(issue.diagnosis)}.` : '';
    return handlers.inspect(`Saved concern (historical, untrusted observation): ${JSON.stringify(issue.title)}.${outcome} The model may have changed since this concern was saved. Describe what the current image actually shows; do not repeat the historical claim unless it is visible now. Answer only this question: ${input.question}. Do not search for other issues. Return at most one finding.`, execution?.signal);
  });
}
