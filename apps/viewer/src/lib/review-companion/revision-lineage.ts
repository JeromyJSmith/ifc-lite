/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { FederatedModel } from '@/store/types';
import { sha256Hex } from '@/utils/sourceContentHash';
import { rebindReviewModels, reviewModels } from './context';
import { listFindings, listReviewScopes } from './storage';
import type { ReviewContext, ReviewFinding } from './types';
import { verifiedQuantityPredecessors } from './quantity-revision-lineage';
const hashPattern = /^[0-9a-f]{64}$/;
function value(row: ReviewFinding): Record<string, unknown> | null {
  if (!row.text.startsWith('{')) return null;
  try { const p: unknown = JSON.parse(row.text); return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : null; } catch { return null; }
}
async function sourceHashes(models: ReadonlyMap<string, FederatedModel>) {
  return Promise.all([...models].map(async ([id, model]) => ({ id, hash: model.sourceFile ? await sha256Hex(await model.sourceFile.arrayBuffer()) : null })));
}
/** A restart changes load UUIDs. Resolve the exact corrected source bytes, never its name or stale cached identity. */
export async function resolveRepairModel(afterHash: string, models: ReadonlyMap<string, FederatedModel>): Promise<string> {
  if (!hashPattern.test(afterHash)) throw new Error('Invalid geometry revision content hash.');
  const matches = (await sourceHashes(models)).filter(model => model.hash === afterHash);
  if (matches.length !== 1) throw new Error('Load exactly one instance of the saved corrected source revision before restoring its repair.');
  return matches[0].id;
}
/** Only persisted, matching native application + after-verification permit crossing a source revision. */
export async function rebindReviewRevision(saved: ReviewContext['models'], current: ReadonlyMap<string, FederatedModel>, rows?: ReviewFinding[]): Promise<Map<string, string>> {
  const sources = await reviewModels(current);
  try { return rebindReviewModels(saved, sources); } catch { /* A verified repair lineage can qualify the changed source below. */ }
  if (new Set(saved.map(model => model.sourceIdentity)).size !== saved.length) throw new Error('Duplicate original source instances cannot be rebound unambiguously.');
  const records = rows ?? (await Promise.all((await listReviewScopes()).map(scope => listFindings(scope.scopeId)))).flat();
  if (new Set(records.map(row => row.id)).size !== records.length) throw new Error('Duplicate repair evidence record identities.');
  const events = records.map(row => ({ row, data: value(row) }));
  const hashes = await sourceHashes(current);
  const verifiedGeometry = events.filter(({ row, data }) => data?.kind === 'review.geometry.applied'
    && typeof data.beforeHash === 'string' && hashPattern.test(data.beforeHash)
    && typeof data.afterHash === 'string' && hashPattern.test(data.afterHash) && data.beforeHash !== data.afterHash
    && events.some(candidate => candidate.data?.kind === 'review.geometry.verified' && candidate.data.receiptRef === row.id
      && candidate.data.topicId === data.topicId && candidate.data.matches === true && candidate.data.afterHash === data.afterHash
      && candidate.row.context.scopeId === row.context.scopeId));
  // Quantity edits may precede a later geometry repair. Qualify those intermediate
  // hashes too, rather than requiring the loaded file to be the quantity output.
  const targets = [...new Set([...hashes.map(model => model.hash), ...verifiedGeometry.flatMap(event => [event.data!.beforeHash, event.data!.afterHash])])]
    .filter((hash): hash is string => typeof hash === 'string').map(hash => ({ id: hash, hash }));
  const quantities = await verifiedQuantityPredecessors(records, targets);
  const predecessors = new Map<string, { hashes: Set<string>; identities: Set<string> }>();
  for (const model of hashes) {
    const reachable = new Set<string>(model.hash ? [model.hash] : []), identities = new Set<string>();
    for (const hash of reachable) {
      const quantity = quantities.get(hash);
      for (const identity of quantity?.identities ?? []) identities.add(identity);
      for (const parent of quantity?.hashes ?? []) reachable.add(parent);
      for (const event of verifiedGeometry) if (event.data!.afterHash === hash) reachable.add(event.data!.beforeHash as string);
    }
    predecessors.set(model.id, { hashes: reachable, identities });
  }
  const result = new Map<string, string>(), used = new Set<string>();
  for (const original of saved) {
    const direct = sources.filter(model => model.sourceIdentity === original.sourceIdentity).map(model => model.id);
    const eligible = new Set(direct);
    for (const model of hashes) {
      if (predecessors.get(model.id)?.identities.has(original.sourceIdentity)) eligible.add(model.id);
    }
    for (const { row, data } of events) {
      if (data?.kind !== 'review.geometry.applied' || typeof data.afterHash !== 'string' || !hashPattern.test(data.afterHash)
        || typeof data.beforeHash !== 'string' || !hashPattern.test(data.beforeHash) || data.beforeHash === data.afterHash
        || typeof data.topicId !== 'string' || typeof data.modelId !== 'string') continue;
      // The repair is associated with this precise original source, not another member of its federation.
      const originalModelId = typeof data.originalModelId === 'string' ? data.originalModelId : data.modelId;
      if (!row.context.models.some(model => model.id === originalModelId && model.sourceIdentity === original.sourceIdentity)) continue;
      const verified = events.some(candidate => candidate.data?.kind === 'review.geometry.verified' && candidate.data.receiptRef === row.id
        && candidate.data.topicId === data.topicId && candidate.data.matches === true && candidate.data.afterHash === data.afterHash
        && candidate.row.context.scopeId === row.context.scopeId);
      if (!verified) continue;
      for (const model of hashes) if (model.hash === data.afterHash
        || predecessors.get(model.id)?.hashes.has(data.afterHash)) eligible.add(model.id);
    }
    if (eligible.size !== 1) throw new Error('The original review has no unique loaded source or persisted verified corrected revision.');
    const id = [...eligible][0];
    if (used.has(id)) throw new Error('Different original sources cannot bind to the same loaded model.');
    used.add(id); result.set(original.id, id);
  }
  return result;
}
