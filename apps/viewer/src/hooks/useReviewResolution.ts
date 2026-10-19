/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useMemo, useRef, useState, useEffect } from 'react';
import { useViewerStore } from '@/store';
import { useIfcLoader } from './useIfcLoader';
import { parseIfcxViewerModel } from './ingest/viewerModelIngest';
import { createWorkspaceTools } from '@/lib/review-companion/workspace-tools';
import { createNativeTools } from '@/lib/review-companion/native-tools';
import { reviewBcfViewpoint } from '@/lib/review-companion/bcf';
import { saveIssueViewpoint, type RepairViewBinding } from '@/lib/review-companion/issue-viewpoint';
import { reviewModels } from '@/lib/review-companion/context';
import { toGlobalIdFromModels } from '@/store/globalId';
import { createIssueWorkflow, createIssueWorkflowTools, recordGeometryApplication, recordContactMeasurement, saveIssueDiagnosis, type IssueUpdate } from '@/lib/review-companion/issue-workflow';
import { createReviewTool } from '@/lib/review-companion/tools';
import { inspectIfcxGeometry, patchIfcxGeometry, type IfcxGeometryOperation } from '@/lib/review-companion/ifcx-geometry';
import { measureIfcxEntityDistance } from '@/lib/review-companion/geometry-distance';
import { inspectIfcxContact } from '@/lib/review-companion/geometry-contact';
import { inspectGeometryComponent } from '@/lib/review-companion/geometry-component';
import { saveGeometryPlan, readGeometryPlan, listGeometryPlans } from '@/lib/review-companion/geometry-plans';
import { readIfcxWorldGeometry, summarizeWorldGeometry } from '@/lib/review-companion/ifcx-world-geometry';
import { resolveGeometryTarget } from '@/lib/review-companion/geometry-target';
import { summarizeIfcxGeometry } from '@/lib/review-companion/geometry-evidence';
import { saveGeometrySource, readGeometrySource, loadGeometrySourceRecords } from '@/lib/review-companion/geometry-sources';
import { verifyGeometryCleanup } from '@/lib/review-companion/geometry-verification';
import { listAllFindings, getFindingsByIds, saveFinding } from '@/lib/review-companion/storage';
import { rebindReviewRevision, resolveRepairModel } from '@/lib/review-companion/revision-lineage';
import { sha256Hex } from '@/utils/sourceContentHash';
import { persistReviewJson } from '@/lib/review-companion/journal';
import { projectIssueWorkflowToBcf } from '@/lib/review-companion/issue-bcf-projection';
import type { ReviewContext, ReviewFinding } from '@/lib/review-companion/types';

type Options = { scope: string; findings: ReviewFinding[]; capture(): Promise<ReviewContext>; persist(row: ReviewFinding): Promise<string>;
  restore(id: string): Promise<unknown>; open(topicId: string): Promise<unknown>; applyViewpoint(context: ReviewContext): void };
const encode = (value: unknown) => JSON.stringify(value);
export async function allReviewRows() { return listAllFindings(); }
function payload(row: ReviewFinding | undefined): Record<string, unknown> | null {
  if (!row) return null; try { return JSON.parse(row.text); } catch { return null; }
}
const concise = (report: ReturnType<typeof inspectIfcxGeometry>) => ({ ...report, meshes: report.meshes.map(m => ({ path: m.analysis.path, analysis: m.analysis, transform: m.transform })) });

/** Saved issue, source revision and actual native effects share one local journal. */
export function useReviewResolution(options: Options) {
  const live = useRef(options); live.current = options;
  const { loadFile } = useIfcLoader();
  const loader = useRef(loadFile); loader.current = loadFile;
  const [issues, setIssues] = useState<Awaited<ReturnType<ReturnType<typeof createIssueWorkflow>['list']>>>([]);
  const [plans, setPlans] = useState<ReturnType<typeof listGeometryPlans>>([]);
  const [repairs, setRepairs] = useState<Array<{ receiptRef: string; topicId: string; modelName: string; before: { faceCount: number } | null; after: { faceCount: number } | null }>>([]);
  const activeTopic = useRef<string | null>(null);
  const workflowRef = useRef<ReturnType<typeof createIssueWorkflow> | null>(null);
  const record = async (value: unknown, base?: ReviewFinding) => {
    const context = base?.context ?? await live.current.capture();
    const row: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'note', context, text: '', createdAt: new Date().toISOString(), parentId: base?.id };
    return persistReviewJson(row, value, live.current.persist);
  };
  const source = async (modelId: string) => {
    const model = useViewerStore.getState().models.get(modelId);
    if (!model?.sourceFile || model.ifcDataStore?.schemaVersion !== 'IFC5') throw new Error('Choose a loaded IFCX model with its retained original source file.');
    if (useViewerStore.getState().mutationViews.get(modelId)?.getMutations().length) throw new Error('Save or reconcile existing native edits before replacing source geometry.');
    const buffer = await model.sourceFile.arrayBuffer();
    const hash = await sha256Hex(buffer); if (!hash) throw new Error('Source hashing is unavailable.');
    return { model, buffer, hash };
  };
  const load = async (modelId: string, name: string, buffer: ArrayBuffer) => {
    const loaded = useViewerStore.getState().models;
    const target = (loaded.size === 0 || loaded.size === 1 && loaded.has(modelId)) ? { kind: 'primary' as const, modelId } : { kind: 'federated' as const, modelId, name };
    await loader.current(new File([buffer], name, { type: 'application/json' }), target);
    const current = await source(modelId);
    if (current.hash !== await sha256Hex(buffer)) throw new Error('Canonical viewer load did not retain the expected corrected source.');
    return current;
  };
  const workflow = useMemo(() => createIssueWorkflow({
    rows: allReviewRows, persist: row => live.current.persist(row),
    restore: async id => {
      await live.current.restore(id);
      const issue = (await workflowRef.current!.list()).find(i => i.findingId === id);
      if (issue) { activeTopic.current = issue.topicId; await live.current.open(issue.topicId); }
    },
    verify: async (update: IssueUpdate) => {
      const rows = await getFindingsByIds([update.mutationReceiptRef!, update.verificationRef!]), receipt = payload(rows.find(r => r.id === update.mutationReceiptRef)), verification = payload(rows.find(r => r.id === update.verificationRef));
      if (receipt?.kind !== 'review.geometry.applied' || verification?.kind !== 'review.geometry.verified' || receipt.topicId !== update.topicId || verification.topicId !== update.topicId
        || verification.receiptRef !== update.mutationReceiptRef || verification.matches !== true || receipt.afterHash !== verification.afterHash) throw new Error('This issue has no matching persisted geometry application and verified after-source. Keep the issue open.');
      const current = await source(await resolveRepairModel(String(receipt.afterHash), useViewerStore.getState().models));
      if (current.hash !== receipt.afterHash) throw new Error('The verified corrected revision is no longer loaded. Reopen or verify the current revision.');
      const original = receipt.beforeSource as { manifestRef: string };
      await verifyGeometryCleanup(receipt, verification, await loadGeometrySourceRecords(original.manifestRef, getFindingsByIds), current.buffer);
      // Numeric mesh cleanup proves only the explicitly diagnosed mesh defect.
      const issue = (await workflowRef.current!.list()).find(i => i.topicId === update.topicId);
      if (['remove_defective_faces', 'replace_mesh'].includes(String(receipt.operation)) && !issue?.title.startsWith('Mesh integrity:')) throw new Error('Mesh cleanup does not prove the original architectural concern is resolved. Resolve the mesh-integrity subissue and retain the visual concern.');
    },
    onStatus: async (topicId, _stage, row) => {
      if (!useViewerStore.getState().bcfProject?.topics.has(topicId)) await live.current.open(topicId);
      projectIssueWorkflowToBcf(topicId, row.context.scopeId, [row]);
    },
  }), []);
  workflowRef.current = workflow;
  // Source chunks append hundreds of rows; they must not trigger full screenshot-journal reads.
  const outcomeKey = options.findings.filter(row => /\"kind\":\"review\.(bcf\.(definition|workflow)|geometry\.(applied|plan))\"/.test(row.text)).map(row => row.id).join(',');
  useEffect(() => { void workflow.list().then(setIssues); void allReviewRows().then(rows => { setPlans(listGeometryPlans(rows)); setRepairs(rows.flatMap(row => { const p = payload(row); return p?.kind === 'review.geometry.applied' ? [{ receiptRef: row.id, topicId: String(p.topicId), modelName: String(p.modelName ?? 'Repaired model'), before: p.before as { faceCount: number } | null, after: p.after as { faceCount: number } | null }] : []; })); }); }, [workflow, outcomeKey, options.scope]);
  const saveView = async (topicId: string, note: string, repair?: Omit<RepairViewBinding, 'sourceIdentity'>) => {
    await live.current.open(topicId);
    const identity = repair ? (await reviewModels(useViewerStore.getState().models)).find(model => model.id === repair.modelId) : undefined;
    if (repair && !identity) throw new Error('The repaired model is no longer loaded.');
    const binding = repair && identity ? { ...repair, sourceIdentity: identity.sourceIdentity } : undefined;
    return saveIssueViewpoint({ topicId, note, binding, capture: () => live.current.capture(), persist: row => live.current.persist(row),
      qualify: async () => {
        if (!binding) return;
        if ((await source(binding.modelId)).hash !== binding.sourceHash) throw new Error('The repaired source changed before its after-view was saved.');
        if (!(await reviewModels(useViewerStore.getState().models)).some(model => model.id === binding.modelId && model.sourceIdentity === binding.sourceIdentity)) throw new Error('The repaired placement changed before its after-view was saved.');
      },
      install: async context => {
        const viewpoint = reviewBcfViewpoint(context.viewpoint); useViewerStore.getState().addViewpoint(topicId, viewpoint);
        return !!useViewerStore.getState().bcfProject?.topics.get(topicId)?.viewpoints.some(view => view.guid === viewpoint.guid && view.snapshot === viewpoint.snapshot);
      } });
  };
  const actions = useRef({ record, source, load, saveView }); actions.current = { record, source, load, saveView };
  const nativeTools = useMemo(() => createNativeTools({
    record: event => actions.current.record({ ...event, topicId: activeTopic.current }),
    readback: () => { const s = useViewerStore.getState(); return { mutationVersion: s.mutationVersion, modelIds: [...s.models.keys()], selection: [...s.selectedEntityIds] }; },
  }), []);
  const workspaceTools = useMemo(() => createWorkspaceTools({ record: event => actions.current.record({ ...event, topicId: activeTopic.current }) }), []);
  const id = { type: 'string' as const, minLength: 1, maxLength: 200 };
  const geometryTools = useMemo(() => [
    createReviewTool('review_geometry_contact', 'Inspect native shared surface patches, intersection lines and nearest distance between two IFCX entities. Use exact geometryTargets. instanceA=-1 and triangleA=-1 inspect all instances; otherwise choose an exact composed instance and triangle (triangleA=-1 means its whole mesh). Rendered hit indices require checking correspondence to the composed instance; they are not source polygon indices. Returns bounded located contact geometry. Does not edit or close issues.', { modelId: id, targetA: id, targetB: id, instanceA: { type: 'integer', minimum: -1, maximum: Number.MAX_SAFE_INTEGER }, triangleA: { type: 'integer', minimum: -1, maximum: Number.MAX_SAFE_INTEGER } }, false, async (input, execution) => {
      const modelId = input.modelId as string, source = await actions.current.source(modelId), topicId = execution?.issueTopicId ?? activeTopic.current;
      const issue = execution?.issueTopicId ? (await workflow.list()).find(row => row.topicId === topicId) : undefined;
      if (execution?.issueTopicId && !issue) throw new Error('Selected issue disappeared before measurement.');
      if (issue) {
        const bindings = await rebindReviewRevision(issue.context.models, useViewerStore.getState().models);
        if (![...bindings.values()].includes(modelId)) throw new Error('The measured model does not belong to this saved issue.');
      }
      const resolve = (target: string) => resolveGeometryTarget(target, id => useViewerStore.getState().models.get(modelId)?.ifcDataStore?.entities.getGlobalId(id));
      const result = inspectIfcxContact(source.buffer, resolve(input.targetA as string), resolve(input.targetB as string), input.instanceA as number, input.triangleA as number);
      if ((await actions.current.source(modelId)).hash !== source.hash) throw new Error('Source changed during contact analysis. Inspect the current revision.');
      const evidenceRef = await actions.current.record({ kind: 'review.geometry.contact', topicId, modelId, sourceHash: source.hash, result });
      const issueRecord = issue ? await recordContactMeasurement(workflow, { topicId: issue.topicId, expectedWorkflowRef: issue.workflowRef,
        evidenceRef, sourceHash: source.hash, pathA: result.pathA, pathB: result.pathB, contactCount: result.contactCount,
        distance: result.nearest?.distance ?? null, instanceA: result.scope.instanceA, triangleA: result.scope.triangleA }) : null;
      return { sourceHash: source.hash, evidenceRef, issueRecord, ...result };
    }),
    createReviewTool('review_geometry_component', 'Inspect one connected component of an exact IFCX source mesh by source face index. Exact coincident vertices connect faces. Returns bounds, face count, and a bounded remove_faces plan when this is a proper subset of the mesh. A rendered triangle index is not a source face index for polygon meshes. This analysis does not establish a defect or authorize a change.', { modelId: id, meshPath: id, seedFaceIndex: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }, false, async input => {
      const modelId = input.modelId as string, before = await actions.current.source(modelId);
      const result = inspectGeometryComponent(before.buffer, input.meshPath as string, input.seedFaceIndex as number);
      if ((await actions.current.source(modelId)).hash !== before.hash) throw new Error('Source changed during component analysis. Inspect the current revision.');
      const evidenceRef = await actions.current.record({ kind: 'review.geometry.component', modelId, topicId: activeTopic.current, sourceHash: before.hash, result });
      return { sourceHash: before.hash, evidenceRef, ...result };
    }),
    createReviewTool('review_geometry_measure', 'Measure the native triangle-surface minimum distance between exactly two different entities in the same IFCX model. Use geometryTargets returned by review_state. Returns source hash, closest witness points and triangle/instance IDs. This is the global minimum, not a localized junction proof; zero can mean touching or intersection elsewhere. Does not edit geometry or close issues.', { modelId: id, targetA: id, targetB: id }, false, async input => {
      const modelId = input.modelId as string;
      const { buffer, hash } = await actions.current.source(modelId);
      const resolve = (target: string) => resolveGeometryTarget(target, id => useViewerStore.getState().models.get(modelId)?.ifcDataStore?.entities.getGlobalId(id));
      const result = measureIfcxEntityDistance(buffer, resolve(input.targetA as string), resolve(input.targetB as string));
      const context = await live.current.capture();
      if ((await actions.current.source(modelId)).hash !== hash) throw new Error('Source changed during measurement; measure the current revision again.');
      const finding: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), context, kind: 'note', createdAt: new Date().toISOString(), text: `Native surface-distance measurement for ${result.pathA} and ${result.pathB}. No repair or architectural acceptance is claimed.` };
      await live.current.persist(finding);
      const evidenceRef = await actions.current.record({ kind: 'review.geometry.distance', topicId: activeTopic.current, modelId, sourceHash: hash, result }, finding);
      return { sourceHash: hash, evidenceRef, ...result };
    }),
    createReviewTool('review_geometry_read', 'Read exact source mesh arrays in pages for native geometric analysis and explicit replacement. No approximate image geometry. Use worldPoints with an entity geometryTarget (for example #17) for composed model-space Y-up points with source transforms applied; these are not georeferenced coordinates. Other components use an exact returned mesh path: points, faceVertexIndices, faceVertexCounts, normals, boundaryEdges, nonManifoldEdges, degenerateFaces or duplicateFaces; Request only the small page needed for the current question (at most 256 items). offset and limit address that exact source or topology array.', {
      modelId: id, path: id, component: { type: 'string', enum: ['worldPoints', 'points', 'faceVertexIndices', 'faceVertexCounts', 'normals', 'boundaryEdges', 'nonManifoldEdges', 'degenerateFaces', 'duplicateFaces'] }, offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: 'integer', minimum: 1, maximum: 256 },
    }, true, async input => {
      const { buffer, hash } = await actions.current.source(input.modelId as string);
      const path = resolveGeometryTarget(input.path as string, id => useViewerStore.getState().models.get(input.modelId as string)?.ifcDataStore?.entities.getGlobalId(id));
      if (input.component === 'worldPoints') {
        const world = readIfcxWorldGeometry(buffer, path);
        const offset = input.offset as number, limit = input.limit as number;
        return { sourceHash: hash, ...summarizeWorldGeometry(world), offset, points: world.points.slice(offset, offset + limit), total: world.points.length };
      }
      const report = inspectIfcxGeometry(buffer, path);
      const entry = report.meshes.find(m => m.analysis.path === input.path);
      if (!entry) return { sourceHash: hash, meshPaths: report.meshes.map(m => m.analysis.path), next: 'Choose an exact mesh path.' };
      const component = input.component as string;
      const data = ['boundaryEdges', 'nonManifoldEdges', 'degenerateFaces', 'duplicateFaces'].includes(component)
        ? entry.analysis[component as keyof typeof entry.analysis] : entry.mesh[component as keyof typeof entry.mesh];
      if (!Array.isArray(data)) return { sourceHash: hash, component: input.component, present: false };
      return { sourceHash: hash, path: input.path, component: input.component, total: data.length, offset: input.offset, values: data.slice(input.offset as number, (input.offset as number) + (input.limit as number)), transform: report.transform, coordinateSpace: 'Source mesh-local IFCX Z-up; verify declared units before changing dimensions.' };
    }),
    createReviewTool('review_attach_issue_view', 'Save the current actual image, camera and selected element identities as an additional BCF issue viewpoint. Preserves the original view. Use after selecting the repaired element and checking the corrected scene.', { topicId: id, note: { type: 'string', minLength: 1, maxLength: 8000 } }, false, async input => {
      return actions.current.saveView(input.topicId as string, input.note as string);
    }),
    createReviewTool('review_geometry_repairs', 'List actual persisted geometry applications and their matching verification records, including IDs needed to finish issue resolution or Undo. These are source/readback facts, not blanket architectural acceptance.', {}, true, async () => {
      const rows = await allReviewRows();
      return rows.flatMap(row => { const r = payload(row); if (r?.kind !== 'review.geometry.applied') return [];
        const checked = rows.find(v => { const p = payload(v); return p?.kind === 'review.geometry.verified' && p.receiptRef === row.id && p.afterHash === r.afterHash; });
        const v = payload(checked);
        return [{ topicId: r.topicId, receiptRef: row.id, verificationRef: checked?.id, operation: r.operation, path: r.path, modelId: r.modelId, modelName: r.modelName, beforeHash: r.beforeHash, afterHash: r.afterHash, before: r.before, after: r.after, matches: v?.matches, loadedTriangles: v?.loadedTriangles, actual: v?.actual }];
      });
    }),
    createReviewTool('review_geometry_inspect', 'Read one IFCX element using the geometryTarget returned by review_state (such as #176), or an exact mesh prim path returned by this tool. Never invent /IFCRoot/ paths. Report actual topology, mesh-local coordinates and transforms; persist a measured mesh-integrity candidate when exact zero-area or same-winding duplicate faces exist. Also return composed model-space placement using the native viewer transform pipeline. Architectural holes are not automatically defects.', { modelId: id, path: id }, false, async input => {
      const { buffer, hash } = await actions.current.source(input.modelId as string);
      const path = resolveGeometryTarget(input.path as string, id => useViewerStore.getState().models.get(input.modelId as string)?.ifcDataStore?.entities.getGlobalId(id));
      const report = inspectIfcxGeometry(buffer, path);
      const state = useViewerStore.getState(), entityId = state.models.get(input.modelId as string)?.ifcDataStore?.entities.getExpressIdByGlobalId(path);
      if (entityId && entityId > 0) {
        const ref = { modelId: input.modelId as string, expressId: entityId }, globalId = toGlobalIdFromModels(state.models, ref.modelId, ref.expressId);
        state.clearSelection(); state.setSelectedEntity(ref); state.setSelectedEntityIds([globalId]); state.setSelectedEntityId(globalId);
      }
      const context = await live.current.capture();
      const defective = report.meshes.filter(m => m.analysis.degenerateFaces.length || m.analysis.duplicateFaces.length);
      const candidate: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), context, kind: defective.length ? 'candidate' : 'note', createdAt: new Date().toISOString(),
        text: defective.length ? `Mesh integrity: ${defective.map(m => `${m.analysis.path}: ${m.analysis.degenerateFaces.length} exact zero-area faces and ${m.analysis.duplicateFaces.length} same-winding duplicate faces`).join('; ')}. These are measured source mesh defects; removing them does not establish the architectural gap or fascia detail is wrong.` : `No exact zero-area or same-winding duplicate mesh faces at ${input.path}.` };
      await live.current.persist(candidate);
      const placement = entityId && entityId > 0 ? summarizeWorldGeometry(readIfcxWorldGeometry(buffer, path)) : { available: false, reason: 'Composed placement requires the owning entity geometryTarget, not a mesh path.' };
      const evidenceRef = await actions.current.record({ kind: 'review.geometry.inspection', topicId: activeTopic.current, sourceHash: hash, modelId: input.modelId, report: concise(report), placement }, candidate);
      return { placement, sourceHash: hash, sourceHeader: JSON.parse(new TextDecoder().decode(buffer)).header, coordinateContract: 'Mesh-local Z-up. Source header is reported verbatim; a missing unit is unknown. Exact zero-area and duplicate-face cleanup is unit independent.', candidateId: defective.length ? candidate.id : null, evidenceRef, ...summarizeIfcxGeometry(report) };
    }),
    createReviewTool('review_geometry_repair', 'Apply an evidence-backed exact-source IFCX geometry operation in the visible viewer and preserve original/corrected sources for restart-safe undo. operationJson: remove_defective_faces{meshPath}, remove_faces{meshPath,faceIndices}, translate_mesh_local{meshPath,delta:[x,y,z]}, replace_mesh{meshPath,mesh}, set_local_transform{path,transform:4x4}. All require kind. Coordinates are IFCX mesh-local Z-up in declared document units. Read geometry and units first. Never invent replacement geometry. Does not automatically resolve architectural concerns.', {
      topicId: id, modelId: id, expectedSourceHash: id, operationJson: { type: 'string', minLength: 1, maxLength: 1000000 }, diagnosis: { type: 'string', minLength: 1, maxLength: 8000 },
    }, false, async (input, execution) => {
      const topicId = input.topicId as string, modelId = input.modelId as string;
      const original = (await allReviewRows()).find(row => payload(row)?.kind === 'review.bcf.definition' && payload(row)?.topicId === topicId);
      if (!original) throw new Error('Choose a saved BCF issue before repairing its geometry.');
      const bindings = await rebindReviewRevision(original.context.models, useViewerStore.getState().models);
      const originalModelId = [...bindings].find(([, actual]) => actual === modelId)?.[0];
      if (!originalModelId) throw new Error('The repair model is not part of this issue’s verified source lineage.');
      const before = await actions.current.source(modelId);
      if (before.hash !== input.expectedSourceHash) throw new Error('Source changed since inspection. Read its geometry again.');
      const operation = JSON.parse(input.operationJson as string) as IfcxGeometryOperation;
      const result = patchIfcxGeometry(before.buffer, operation);
      const parsed = await parseIfcxViewerModel(result.correctedBuffer); if (!parsed.geometryResult.meshes.length) throw new Error('Corrected source contains no renderable geometry.');
      const beforeSource = await saveGeometrySource(before.buffer, original, async row => { await saveFinding(row); return row.id; });
      const afterSource = await saveGeometrySource(result.correctedBuffer, original, async row => { await saveFinding(row); return row.id; });
      const preparedRef = await actions.current.record({ kind: 'review.geometry.prepared', topicId, modelId, path: result.path, operation: result.operation, diagnosis: input.diagnosis, beforeSource, afterSource, before: result.before, after: result.after }, original);
      // Final stale-source check occurs after persistence, immediately before canonical load.
      if ((await actions.current.source(modelId)).hash !== before.hash) throw new Error('Source changed while preserving repair evidence. Nothing applied.');
      const camera = await live.current.capture();
      execution?.signal?.throwIfAborted();
      // After canonical load starts, retain its actual readback and receipts even if cancelled.
      await actions.current.load(modelId, before.model.name, result.correctedBuffer);
      const after = await actions.current.source(modelId);
      const expectedTriangles = parsed.geometryResult.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
      const loadedTriangles = after.model.geometryResult?.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
      live.current.applyViewpoint(camera);
      useViewerStore.getState().setChatPanelVisible(true);
      useViewerStore.getState().setActiveTopic(topicId);
      const targetState = useViewerStore.getState(), targetId = targetState.models.get(modelId)?.ifcDataStore?.entities.getExpressIdByGlobalId(result.path);
      if (targetId && targetId > 0) {
        const ref = { modelId, expressId: targetId }, globalId = toGlobalIdFromModels(targetState.models, modelId, targetId);
        targetState.clearSelection(); targetState.setSelectedEntity(ref); targetState.setSelectedEntityIds([globalId]); targetState.setSelectedEntityId(globalId);
      }
      const receiptRef = await actions.current.record({ kind: 'review.geometry.applied', topicId, modelId, originalModelId, modelName: before.model.name, path: result.path, operation: result.operation, diagnosis: input.diagnosis, beforeHash: before.hash, afterHash: after.hash, beforeSource, afterSource, preparedRef, before: result.before && { faceCount: result.before.faceCount, degenerateCount: result.before.degenerateFaces.length, duplicateCount: result.before.duplicateFaces.length }, after: result.after && { faceCount: result.after.faceCount, degenerateCount: result.after.degenerateFaces.length, duplicateCount: result.after.duplicateFaces.length } }, original);
      const actual = concise(inspectIfcxGeometry(after.buffer, result.path));
      const matches = after.hash === afterSource.hash && loadedTriangles === expectedTriangles;
      const issueVerified = matches && result.operation === 'remove_defective_faces' && actual.meshes.every(m => !m.analysis.degenerateFaces.length && !m.analysis.duplicateFaces.length);
      const verificationRef = await actions.current.record({ kind: 'review.geometry.verified', topicId, receiptRef, afterHash: after.hash, matches, issueVerified, canonicalMeshCount: parsed.geometryResult.meshes.length, expectedTriangles, loadedTriangles, actual: actual.meshes.map(m => ({ path: m.path, faceCount: m.analysis.faceCount, degenerateCount: m.analysis.degenerateFaces.length, duplicateCount: m.analysis.duplicateFaces.length, bounds: m.analysis.bounds })) }, original);
      let afterView;
      if (matches) {
        try { afterView = await actions.current.saveView(topicId, `Actual after-view of native ${result.operation}. Application ${receiptRef}; readback ${verificationRef}; source ${after.hash}. ${String(input.diagnosis).slice(0, 6000)}`, { modelId, sourceHash: after.hash, receiptRef }); }
        catch (error) { afterView = { saved: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      const disposition = await recordGeometryApplication(workflow, { topicId, operation: result.operation, receiptRef, verificationRef, sourceHash: after.hash, sourceVerified: matches, beforeFaces: result.before?.faceCount ?? null, afterFaces: result.after?.faceCount ?? null, diagnosis: input.diagnosis as string, viewpointRef: afterView && 'viewpointRef' in afterView ? afterView.viewpointRef : undefined });
      // Loader owns render/identity; the issue's original image remains untouched.
      useViewerStore.getState().setBcfPanelVisible(false);
      return { applied: true, verified: issueVerified, sourceVerified: matches, workflowRef: disposition.workflowRef, issueRecord: disposition, afterView, removedFaceCount: result.before && result.after ? result.before.faceCount - result.after.faceCount : null, duplicateAndDegenerateCategoriesOverlap: true, receiptRef, verificationRef, beforeHash: before.hash, afterHash: after.hash, before: result.before, after: result.after, previousViewpoint: camera.viewpoint.guid,
        next: 'Inspect the actual corrected view. Close only the diagnosed mesh defect; an architectural concern needs its own verification.' };
    }),
    createReviewTool('review_geometry_verify', 'Verify a persisted mesh repair against its archived original, actual current source and canonical loaded triangles. Close only its Mesh integrity issue after the exact cleanup or solid-equivalent normalization passes. Works after an interrupted application without applying it again.', { receiptRef: id }, false, async (input, execution) => {
      const row = (await getFindingsByIds([String(input.receiptRef)]))[0], receipt = payload(row);
      if (!row || receipt?.kind !== 'review.geometry.applied') throw new Error('No persisted geometry application has this receipt.');
      const modelId = await resolveRepairModel(String(receipt.afterHash), useViewerStore.getState().models);
      const current = await actions.current.source(modelId);
      const original = receipt.beforeSource as { manifestRef: string };
      const rows = await loadGeometrySourceRecords(original.manifestRef, getFindingsByIds);
      const checked = await verifyGeometryCleanup(receipt, { matches: true, afterHash: current.hash }, rows, current.buffer);
      const parsed = await parseIfcxViewerModel(current.buffer);
      const expectedTriangles = parsed.geometryResult.meshes.reduce((n, mesh) => n + mesh.indices.length / 3, 0);
      const loadedTriangles = current.model.geometryResult?.meshes.reduce((n, mesh) => n + mesh.indices.length / 3, 0);
      if (expectedTriangles !== loadedTriangles) throw new Error('Loaded geometry does not match the verified source.');
      execution?.signal?.throwIfAborted();
      if ((await actions.current.source(modelId)).hash !== current.hash) throw new Error('Source changed during verification.');
      const verificationRef = await actions.current.record({ kind: 'review.geometry.verified', topicId: receipt.topicId, receiptRef: row.id, afterHash: current.hash, matches: true, issueVerified: true, expectedTriangles, loadedTriangles, check: checked }, row);
      const disposition = await workflow.record({ topicId: String(receipt.topicId), stage: 'fixed', diagnosis: 'Native source/readback and independent exact-source mesh postcondition passed. This resolves the mesh-integrity defect only.', evidenceRefs: [row.id, verificationRef], mutationReceiptRef: row.id, verificationRef });
      const afterView = await actions.current.saveView(String(receipt.topicId), `Verified mesh repair ${row.id}; verification ${verificationRef}; source ${current.hash}.`, { modelId, sourceHash: current.hash, receiptRef: row.id });
      return { verified: true, receiptRef: row.id, verificationRef, disposition, afterView, check: checked };
    }),
    createReviewTool('review_geometry_resume', 'Reopen a saved corrected IFCX source from its preserved records, including after browser or server restart. Original source and saved issues remain preserved.', { receiptRef: id }, false, async (input, execution) => {
      const rows = await allReviewRows(), row = rows.find(r => r.id === input.receiptRef), receipt = payload(row);
      if (!row || receipt?.kind !== 'review.geometry.applied') throw new Error('No saved geometry repair has this receipt.');
      const ref = receipt.afterSource as { manifestRef: string }; const buffer = await readGeometrySource(ref.manifestRef, rows);
      const models = useViewerStore.getState().models;
      let modelId: string;
      try { modelId = await resolveRepairModel(String(receipt.afterHash), models); }
      catch { try { modelId = await resolveRepairModel(String(receipt.beforeHash), models); } catch { modelId = crypto.randomUUID(); } }
      execution?.signal?.throwIfAborted();
      await actions.current.load(modelId, String(receipt.modelName ?? 'reviewed-model.ifcx'), buffer);
      const afterView = rows.filter(candidate => payload(candidate)?.kind === 'review.bcf.viewpoint' && payload(candidate)?.topicId === receipt.topicId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
      live.current.applyViewpoint(afterView?.context ?? row.context);
      useViewerStore.getState().setChatPanelVisible(true);
      const evidenceRef = await actions.current.record({ kind: 'review.geometry.resumed', topicId: receipt.topicId, receiptRef: row.id, sourceHash: receipt.afterHash, modelId }, row);
      return { resumed: true, evidenceRef, modelId, sourceHash: receipt.afterHash };
    }),
    createReviewTool('review_geometry_undo', 'Restore the original source preserved by a geometry repair, verifying that the corrected source is still loaded. Works after restart when its archived source records are present.', { receiptRef: id }, false, async (input, execution) => {
      const rows = await allReviewRows(), row = rows.find(r => r.id === input.receiptRef), receipt = payload(row);
      if (!row || receipt?.kind !== 'review.geometry.applied') throw new Error('No persisted geometry application has this receipt.');
      const liveModelId = await resolveRepairModel(String(receipt.afterHash), useViewerStore.getState().models);
      const current = await actions.current.source(liveModelId);
      if (current.hash !== receipt.afterHash) throw new Error('Undo conflicts with a newer or different source revision.');
      const ref = receipt.beforeSource as { manifestRef: string }; const buffer = await readGeometrySource(ref.manifestRef, rows);
      execution?.signal?.throwIfAborted();
      await actions.current.load(liveModelId, current.model.name, buffer);
      const evidenceRef = await actions.current.record({ kind: 'review.geometry.undone', receiptRef: input.receiptRef, topicId: receipt.topicId, restoredHash: receipt.beforeHash }, row);
      await workflow.record({ topicId: String(receipt.topicId), stage: 'reopened', diagnosis: 'Native geometry correction undone; original source restored and read back.', evidenceRefs: [evidenceRef] });
      return { undone: true, evidenceRef, restoredHash: receipt.beforeHash };
    }),
  ], [workflow]);
  const issueTools = useMemo(() => createIssueWorkflowTools(workflow), [workflow]);
  const planTool = useMemo(() => createReviewTool('review_geometry_repair_plan', 'Apply a previously imported geometry repair plan by its exact saved reference. Large mesh arrays stay in native storage. Requires owner-authorized issue-specific intent. Uses the same source-revision checks, preserved sources, canonical reload, readback and undo as review_geometry_repair.', { topicId: id, planRef: id, diagnosis: { type: 'string', minLength: 1, maxLength: 8000 } }, false, async (input, execution) => {
    const plan = await readGeometryPlan(input.planRef as string, input.topicId as string, await allReviewRows());
    const modelId = await resolveRepairModel(plan.sourceHash, useViewerStore.getState().models);
    return geometryTools.find(tool => tool.name === 'review_geometry_repair')!.execute({ topicId: input.topicId, modelId, expectedSourceHash: plan.sourceHash, operationJson: JSON.stringify(plan.operation), diagnosis: input.diagnosis }, execution);
  }), [geometryTools]);
  const planListTool = useMemo(() => createReviewTool('review_geometry_plans', 'List persisted geometry repair plans for a saved issue. Returns exact plan references, source hashes and mesh summaries without large payloads. Listing does not approve or apply a plan; use review_geometry_repair_plan for source-checked application.', { topicId: id }, true, async input => ({ plans: listGeometryPlans(await allReviewRows(), input.topicId as string) })), []);
  const tools = useMemo(() => [...nativeTools, ...workspaceTools, ...geometryTools, planTool, planListTool, ...issueTools], [nativeTools, workspaceTools, geometryTools, planTool, planListTool, issueTools]);
  return { issues, repairs, plans, workflow, tools, saveView,
    saveDiagnosis: (input: { topicId: string; expectedWorkflowRef: string | undefined; diagnosis: string }) => saveIssueDiagnosis(workflow, input),
    saveRepairView: async (receiptRef: string) => {
      const receipt = payload((await allReviewRows()).find(row => row.id === receiptRef));
      if (receipt?.kind !== 'review.geometry.applied') throw new Error('Choose a saved geometry application.');
      const modelId = await resolveRepairModel(String(receipt.afterHash), useViewerStore.getState().models);
      return actions.current.saveView(String(receipt.topicId), `Actual after-view of saved geometry application ${receiptRef}. Source ${receipt.afterHash}. Architectural acceptance remains separate.`,
        { modelId, sourceHash: String(receipt.afterHash), receiptRef });
    },
    importPlan: async (topicId: string, file: File) => {
      const rows = await allReviewRows(), base = rows.find(row => payload(row)?.kind === 'review.bcf.definition' && payload(row)?.topicId === topicId);
      if (!base) throw new Error('Choose a saved issue before importing a geometry plan.');
      if (file.size > 2_000_000) throw new Error('Geometry plan exceeds 2 MB.');
      const bytes = await file.arrayBuffer(), plan = JSON.parse(new TextDecoder().decode(bytes));
      const modelId = await resolveRepairModel(plan.sourceHash, useViewerStore.getState().models);
      return saveGeometryPlan(bytes, (await actions.current.source(modelId)).buffer, base, topicId, live.current.persist);
    },
    setActive: (topicId: string) => { activeTopic.current = topicId; },
    refresh: async () => setIssues(await workflow.list()) };
}
