/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { createReviewTool } from './tools';
import { verifyEdgePrismAlignment } from './edge-prism-verification';
import { readGeometrySource, loadGeometrySourceRecords } from './geometry-sources';
import { rebindReviewRevision } from './revision-lineage';
import { parseIfcxViewerModel } from '@/hooks/ingest/viewerModelIngest';
import type { FederatedModel } from '@/store/types';
import type { ReviewFinding } from './types';
import type { createIssueWorkflow } from './issue-workflow';
type Lookup = (ids: string[]) => Promise<ReviewFinding[]>;
export async function alignmentSources(receipt: Record<string, unknown>, lookup: Lookup) {
  const load = async (value: unknown) => {
    if (!value || typeof value !== 'object' || !('manifestRef' in value) || typeof value.manifestRef !== 'string') throw new Error('Alignment source archive is missing.');
    return readGeometrySource(value.manifestRef,await loadGeometrySourceRecords(value.manifestRef,lookup));
  };
  return Promise.all([load(receipt.beforeSource),load(receipt.afterSource)]);
}
export async function verifyRecordedAlignment(receipt: Record<string, unknown>, verification: Record<string, unknown>, current: ArrayBuffer, lookup: Lookup) {
  if (verification.postcondition !== 'edge-board-alignment' || verification.appliedAfterHash !== receipt.afterHash || verification.matches !== true) throw new Error('Alignment verification is not bound to this application.');
  const [before,applied] = await alignmentSources(receipt,lookup);
  const checked = await verifyEdgePrismAlignment(receipt,before,applied,current,verification.components);
  if (checked.currentHash !== verification.afterHash) throw new Error('Current source differs from the verified alignment source.');
  return checked;
}
/** Compare the relevant loaded geometry arrays, not just a triangle count. */
export async function qualifyLoadedAlignment(model: FederatedModel, buffer: ArrayBuffer, paths: string[]) {
  const parsed = await parseIfcxViewerModel(buffer);
  const summaries=[];
  for (const path of paths) {
    const expectedId = parsed.dataStore.entities.getExpressIdByGlobalId(path), liveId = model.ifcDataStore?.entities.getExpressIdByGlobalId(path);
    const expected = parsed.geometryResult.meshes.filter(mesh=>mesh.expressId===expectedId), actual = model.geometryResult?.meshes.filter(mesh=>mesh.expressId===liveId) ?? [];
    if (!expected.length || expected.length!==actual.length) throw new Error('Loaded alignment geometry is missing or differs from the canonical source.');
    for (let i=0;i<expected.length;i++) for (const field of ['positions','indices'] as const) {
      const a=expected[i][field],b=actual[i][field];
      if (a.length!==b.length || a.some((value,index)=>value!==b[index])) throw new Error('Loaded alignment positions/indices differ from the canonical source.');
    }
    summaries.push({path,meshCount:actual.length,triangleCount:actual.reduce((n,m)=>n+m.indices.length/3,0)});
  }
  return summaries;
}
export function createAlignmentVerificationTool(options: {
  models(): ReadonlyMap<string,FederatedModel>; rows(): Promise<ReviewFinding[]>; lookup: Lookup;
  source(modelId:string): Promise<{model:FederatedModel;buffer:ArrayBuffer;hash:string}>;
  record(value:unknown,base?:ReviewFinding):Promise<string>;
  workflow: ReturnType<typeof createIssueWorkflow>;
  saveView(topicId:string,note:string,binding:{modelId:string;sourceHash:string;receiptRef:string}):Promise<unknown>;
}) {
  const id={type:'string' as const,minLength:1,maxLength:200};
  return createReviewTool('review_geometry_verify_alignment','Verify an EXISTING edge-board alignment repair and resolve its model-alignment BCF concern. Does not reapply geometry. Requires receiptRef and componentsJson array of {pointOffset,referencePath,referencePointIndices:[a,b]} from the preserved authored plan. Rechecks archived before/applied sources, all moved prism vertices, preserved dimensions/topology, unchanged roof edges, closed solids and canonical loaded geometry; preserves scope limits and an actual after-view.',{receiptRef:id,componentsJson:{type:'string',minLength:1,maxLength:8000}},false,async (input,execution)=>{
    const row=(await options.lookup([String(input.receiptRef)]))[0];
    const receipt=row ? JSON.parse(row.text) as Record<string,unknown> : null;
    if (!row || receipt?.kind!=='review.geometry.applied' || typeof receipt.topicId!=='string') throw new Error('Choose a persisted geometry application.');
    if (execution?.issueTopicId && execution.issueTopicId!==receipt.topicId) throw new Error('Alignment application belongs to a different issue.');
    const binding=await rebindReviewRevision(row.context.models,options.models(),await options.rows());
    const originalId=String(receipt.originalModelId ?? receipt.modelId),modelId=binding.get(originalId);
    if (!modelId) throw new Error('The original board source has no unique verified loaded revision.');
    const current=await options.source(modelId),[before,applied]=await alignmentSources(receipt,options.lookup);
    const check=await verifyEdgePrismAlignment(receipt,before,applied,current.buffer,JSON.parse(input.componentsJson as string));
    const loaded=await qualifyLoadedAlignment(current.model,current.buffer,[check.path,...new Set(check.components.map(c=>c.referencePath))]);
    execution?.signal?.throwIfAborted();
    if ((await options.source(modelId)).hash!==current.hash) throw new Error('Source changed during alignment verification.');
    const verificationRef=await options.record({kind:'review.geometry.verified',postcondition:'edge-board-alignment',topicId:receipt.topicId,receiptRef:row.id,appliedAfterHash:receipt.afterHash,afterHash:current.hash,matches:true,issueVerified:true,components:check.components,check,loaded},row);
    const disposition=await options.workflow.record({topicId:receipt.topicId,stage:'fixed',diagnosis:`Existing edge-board alignment repair verified against archived before/applied sources and current canonical geometry. ${check.checks.length} complete board prisms follow their unchanged roof edges with original dimensions; all moved vertices are covered. ${check.scope}`,evidenceRefs:[row.id,verificationRef],mutationReceiptRef:row.id,verificationRef});
    const afterView=await options.saveView(receipt.topicId,`Verified existing edge-board alignment ${row.id}; verification ${verificationRef}; current source ${current.hash}. ${check.scope}`,{modelId,sourceHash:current.hash,receiptRef:row.id});
    return {verified:true,geometryApplied:false,receiptRef:row.id,verificationRef,disposition,afterView,check};
  });
}
