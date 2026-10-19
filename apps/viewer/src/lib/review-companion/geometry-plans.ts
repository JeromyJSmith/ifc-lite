/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { patchIfcxGeometry, type IfcxGeometryOperation } from './ifcx-geometry';
import { saveGeometrySource, readGeometrySource } from './geometry-sources';
import { sha256Hex } from '@/utils/sourceContentHash';
import type { ReviewFinding } from './types';
export async function saveGeometryPlan(bytes: ArrayBuffer, source: ArrayBuffer, base: ReviewFinding, topicId: string, persist: (row: ReviewFinding) => Promise<string>) {
  if (bytes.byteLength > 2_000_000) throw new Error('Geometry plan exceeds 2 MB.');
  const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { sourceHash: string; operation: IfcxGeometryOperation };
  if (!plan || plan.sourceHash !== await sha256Hex(source)) throw new Error('Geometry plan is for a different source revision.');
  const checked = patchIfcxGeometry(source, plan.operation);
  const stored = await saveGeometrySource(bytes, base, persist);
  const row: ReviewFinding = { ...structuredClone(base), id: crypto.randomUUID(), parentId: base.id, createdAt: new Date().toISOString(), kind: 'note', text: JSON.stringify({ kind: 'review.geometry.plan', topicId, sourceHash: plan.sourceHash, payloadRef: stored.manifestRef, payloadHash: stored.hash, meshPath: checked.path, operation: checked.operation, beforeFaces: checked.before?.faceCount, afterFaces: checked.after?.faceCount }) };
  const planRef = await persist(row);
  if (planRef !== row.id) throw new Error('Geometry plan storage returned a different identity.');
  return { saved: true, planRef, topicId, sourceHash: plan.sourceHash, meshPath: checked.path, operation: checked.operation, beforeFaces: checked.before?.faceCount, afterFaces: checked.after?.faceCount, applied: false };
}
export async function readGeometryPlan(planRef: string, topicId: string, rows: ReviewFinding[]) {
  const row = rows.find(r => r.id === planRef);
  if (!row) throw new Error('Saved geometry plan is missing.');
  const record = JSON.parse(row.text);
  if (record.kind !== 'review.geometry.plan' || record.topicId !== topicId) throw new Error('Geometry plan belongs to a different issue.');
  const bytes = await readGeometrySource(record.payloadRef, rows);
  if (await sha256Hex(bytes) !== record.payloadHash) throw new Error('Geometry plan payload hash differs.');
  const plan = JSON.parse(new TextDecoder().decode(bytes));
  if (plan.sourceHash !== record.sourceHash || plan.operation?.kind !== record.operation) throw new Error('Geometry plan metadata differs from its preserved payload.');
  return { sourceHash: record.sourceHash as string, operation: plan.operation as IfcxGeometryOperation };
}
