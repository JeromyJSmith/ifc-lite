/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { FederatedModel } from '@/store/types';
import type { ReviewContext, ReviewFinding } from './types';
import type { ReviewTool } from './tools';
import { rebindReviewRevision } from './revision-lineage';
import { persistReviewJson } from './journal';
interface SavedIssue { topicId: string; context: ReviewContext }
interface GeometryResult { candidateId?: string | null; sourceHash: string; evidenceRef: string; meshes: Array<{ analysis: { path: string; faceCount: number; degenerateFaces: number[]; duplicateFaces: number[] } }> }
export interface IssuePreparationOptions {
  workflow: { list(): Promise<SavedIssue[]>; investigate(topicId: string): Promise<unknown> };
  capture(): Promise<ReviewContext>;
  viewerTools: readonly ReviewTool[];
  geometryTool: ReviewTool;
  inspect(signal: AbortSignal, instruction: string): Promise<unknown>;
  models(): ReadonlyMap<string, FederatedModel>;
  persist(row: ReviewFinding): Promise<string>;
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
  const context = await options.capture(); signal.throwIfAborted();
  async function camera(name: string, args: Record<string, number>) {
    signal.throwIfAborted();
    const tool = options.viewerTools.find(tool => tool.name === name);
    if (!tool) throw new Error(`Viewer tool ${name} is unavailable.`);
    const result = await tool.execute(args, { signal });
    // Preserve a completed visible movement before honoring a subsequent cancel.
    await persistReviewJson({ schemaVersion: 1, id: crypto.randomUUID(), context, kind: 'note', text: '', createdAt: new Date().toISOString() },
      { kind: 'review.issue.camera', topicId, tool: name, args, result }, options.persist);
    signal.throwIfAborted();
  }
  await camera('viewer_rotate', { azimuthDegrees: 30, elevationDegrees: 8 });
  await camera('viewer_zoom', { factor: 1.15 });
  await options.inspect(signal, 'Inspect this saved concern once. Describe visible evidence and uncertainty. The next phase reads exact geometry; do not infer corrective dimensions.');
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
