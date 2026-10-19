/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { FederatedModel } from '@/store/types';
import type { IfcxDataStore } from '@/hooks/useIfcFederation';
import { computeFullSourceHashFromBlob, sha256Hex } from '@/utils/sourceContentHash';
import type { ReviewContext } from './types';

const hashes = new WeakMap<Blob, Promise<string | null>>();
const stackHashes = new WeakMap<NonNullable<IfcxDataStore['_federatedBuffers']>, Promise<string | null>>();
export async function reviewModels(models: ReadonlyMap<string, FederatedModel>): Promise<ReviewContext['models']> {
  if (!models.size) throw new Error('Load a building model before starting a review.');
  return Promise.all([...models.values()].map(async model => {
    let hash = model.sourceContentHash;
    if (!hash && model.sourceFile) {
      let pending = hashes.get(model.sourceFile);
      if (!pending) { pending = computeFullSourceHashFromBlob(model.sourceFile); hashes.set(model.sourceFile, pending); }
      hash = (await pending) ?? undefined;
    }
    if (hash) return { id: model.id, name: model.name, sourceIdentity: `sha256:${hash}` };
    // Installed useIfcFederation retains exact source buffers for composed IFCX.
    // Hash their ordered bytes and bind each logical model to its original layer.
    const store = model.ifcDataStore as IfcxDataStore | null;
    const buffers = store?._federatedBuffers;
    if (buffers?.length) {
      let pending = stackHashes.get(buffers);
      if (!pending) {
        pending = Promise.all(buffers.map(async b => ({ name: b.name, hash: await sha256Hex(b.buffer) })))
          .then(parts => parts.some(p => !p.hash) ? null : sha256Hex(new TextEncoder().encode(JSON.stringify(parts))));
        stackHashes.set(buffers, pending);
      }
      const stack = await pending;
      if (stack) return { id: model.id, name: model.name, sourceIdentity: `ifcx-stack:${stack}:layer:${store?._federatedLayers?.find(l => l.id === model.id)?.name ?? model.name}` };
    }
    return { id: model.id, name: model.name, sourceIdentity: `session:${model.id}` };
  }));
}

export async function reviewScope(models: ReviewContext['models']): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(models.map(m => m.sourceIdentity).sort())));
  if (!hash) throw new Error('Secure browser hashing is unavailable. Open IFC-Lite on localhost or HTTPS.');
  return `review:${hash}`;
}

/** Bind a saved ref to the same source bytes, not a load-session UUID or file name. */
export function rebindReviewModels(saved: ReviewContext['models'], current: ReviewContext['models']): Map<string, string> {
  const result = new Map<string, string>();
  if (new Set(saved.map(m => m.sourceIdentity)).size !== saved.length) throw new Error('Duplicate saved source instances cannot be restored unambiguously.');
  for (const source of saved) {
    const matches = current.filter(m => m.sourceIdentity === source.sourceIdentity);
    if (matches.length !== 1) throw new Error('Load the same model revision before restoring this viewpoint. Duplicate source instances must be reviewed separately.');
    result.set(source.id, matches[0].id);
  }
  return result;
}

export function candidateContext(context: ReviewContext, indices: number[]): ReviewContext {
  const elements = indices.map(index => context.elements[index]);
  return { ...context, elements, viewpoint: { ...context.viewpoint, components: {
    ...context.viewpoint.components,
    selection: elements.flatMap(e => e.ifcGlobalId ? [{ ifcGuid: e.ifcGlobalId }] : []),
  } } };
}
