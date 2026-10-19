/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
interface SavedIssue { topicId: string; title: string; definitionRef: string; findingId: string }
export interface IssuePreparationOptions {
  workflow: { list(): Promise<SavedIssue[]>; investigate(topicId: string): Promise<unknown>; continueInvestigation?(topicId: string): Promise<unknown> };
  onStatus(text: string): void;
  continueCurrentView?: boolean;
}
export interface PreparedIssueReport { summary: string; evidenceRefs: string[]; viewMode?: 'restored' | 'continued' }
/** Reuse the saved BCF observation. A fresh image is a requested step, not a preload. */
export async function prepareSavedIssue(options: IssuePreparationOptions, topicId: string, signal: AbortSignal): Promise<PreparedIssueReport> {
  signal.throwIfAborted();
  const issue = (await options.workflow.list()).find(row => row.topicId === topicId);
  signal.throwIfAborted();
  if (!issue) throw new Error('Saved issue not found.');
  const continued = options.continueCurrentView === true && !!options.workflow.continueInvestigation;
  if (continued) await options.workflow.continueInvestigation!(topicId);
  else await options.workflow.investigate(topicId);
  signal.throwIfAborted();
  options.onStatus(continued ? 'Continuing this issue in the current view and selection.' : 'Saved BCF view restored. Bonsai will request one next piece of evidence.');
  return { summary: issue.title, evidenceRefs: [...new Set([issue.definitionRef, issue.findingId])], viewMode: continued ? 'continued' : 'restored' };
}

interface Revision { models: object; mutationVersion: number; geometryUpdateTick: number }
export function createIssuePreparationSession() {
  let previous: { topicId: string; revision: Revision } | null = null;
  return {
    reset: () => { previous = null; },
    remember: (topicId: string, revision: Revision) => { previous = { topicId, revision: { models: revision.models, mutationVersion: revision.mutationVersion, geometryUpdateTick: revision.geometryUpdateTick } }; },
    canContinue: (topicId: string, revision: Revision) => previous?.topicId === topicId
      && previous.revision.models === revision.models && previous.revision.mutationVersion === revision.mutationVersion
      && previous.revision.geometryUpdateTick === revision.geometryUpdateTick,
  };
}
export async function runIssuePreparation(options: {
  session: ReturnType<typeof createIssuePreparationSession>; workflow: IssuePreparationOptions['workflow']; state(): Revision;
  running: boolean; controller: { current: AbortController | null }; onBusy(value: boolean): void; onPause(): void; onStatus(text: string): void;
}, topicId: string) {
  if (options.running || options.controller.current) throw new Error('A review is already running.');
  const abort = new AbortController(); options.controller.current = abort; options.onBusy(true); options.onPause();
  try {
    const before = options.state();
    const result = await prepareSavedIssue({ workflow: options.workflow, onStatus: options.onStatus,
      continueCurrentView: options.session.canContinue(topicId, before) }, topicId, abort.signal);
    const after = options.state();
    if (before.models !== after.models || before.mutationVersion !== after.mutationVersion || before.geometryUpdateTick !== after.geometryUpdateTick)
      throw new Error('The model changed during issue preparation. Start this issue step again on the current revision.');
    options.session.remember(topicId, after);
    return result;
  } catch (error) { options.session.reset(); throw error; }
  finally { options.controller.current = null; options.onBusy(false); }
}
