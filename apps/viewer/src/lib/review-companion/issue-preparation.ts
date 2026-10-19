/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { FederatedModel } from '@/store/types';
import type { ReviewContext } from './types';
import type { ReviewTool } from './tools';
import { rebindReviewRevision } from './revision-lineage';
interface SavedIssue { topicId: string; context: ReviewContext }
interface GeometryResult { candidateId?: string | null; sourceHash: string; evidenceRef: string; meshes: Array<{ analysis: { path: string; faceCount: number; degenerateFaces: number[]; duplicateFaces: number[] } }> }
export interface IssuePreparationOptions {
  workflow: { list(): Promise<SavedIssue[]>; investigate(topicId: string): Promise<unknown> };
  geometryTool: ReviewTool;
  inspect(signal: AbortSignal, instruction: string): Promise<unknown>;
  models(): ReadonlyMap<string, FederatedModel>;
  onStatus(text: string): void;
}
export type PreparedIssueReport = { modelId: string; sourceHash: string; candidateId?: string | null; evidenceRef: string;
  meshes: Array<{ path: string; faceCount: number; degenerateCount: number; duplicateCount: number; defectiveFaceCount: number }> }
  | { modelId: string; path: string; error: string };
/** Restore, visibly inspect and measure the actual source before Bonsai chooses a repair. */
export async function prepareSavedIssue(options: IssuePreparationOptions, topicId: string, signal: AbortSignal): Promise<PreparedIssueReport[]> {
  signal.throwIfAborted();
  const issue = (await options.workflow.list()).find(row => row.topicId === topicId);
  signal.throwIfAborted();
  if (!issue) throw new Error('Saved issue not found.');
  await options.workflow.investigate(topicId); signal.throwIfAborted();
  // A BCF perspective camera stores a direction, not its original orbit pivot.
  // Blindly orbiting that reconstructed target can move a close-up off the building.
  // Inspect the actual restored concern first; native navigation remains available
  // when a particular unanswered question calls for another measured viewpoint.
  await options.inspect(signal, 'Inspect this original saved concern once, at its restored viewpoint. Describe visible evidence and uncertainty. The next phase reads exact geometry; do not infer corrective dimensions.');
  signal.throwIfAborted();
  const models = options.models(), bindings = await rebindReviewRevision(issue.context.models, models);
  signal.throwIfAborted();
  if (options.models() !== models) throw new Error('Loaded models changed while preparing the issue.');
  const reports: PreparedIssueReport[] = [], seen = new Set<string>();
  for (const element of issue.context.elements) {
    signal.throwIfAborted();
    if (options.models() !== models) throw new Error('Loaded models changed during geometry inspection.');
    const modelId = bindings.get(element.modelId);
    if (!modelId || !element.ifcGlobalId) continue;
    const key = JSON.stringify([modelId, element.ifcGlobalId]);
    if (seen.has(key)) continue;
    seen.add(key); options.onStatus(`Reading exact geometry for element ${element.expressId}…`);
    try {
      const value = await options.geometryTool.execute({ modelId, path: element.ifcGlobalId }, { signal }) as GeometryResult;
      signal.throwIfAborted();
      reports.push({ modelId, sourceHash: value.sourceHash, candidateId: value.candidateId, evidenceRef: value.evidenceRef,
        meshes: value.meshes.map(m => ({ path: m.analysis.path, faceCount: m.analysis.faceCount, degenerateCount: m.analysis.degenerateFaces.length,
          duplicateCount: m.analysis.duplicateFaces.length, defectiveFaceCount: new Set([...m.analysis.degenerateFaces, ...m.analysis.duplicateFaces]).size })) });
    } catch (error) {
      signal.throwIfAborted();
      reports.push({ modelId, path: element.ifcGlobalId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  options.onStatus('Visual inspection and exact geometry evidence saved. Bonsai is ready to choose the repair.');
  return reports;
}
