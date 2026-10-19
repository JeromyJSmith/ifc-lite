/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { BCFViewpoint } from '@ifc-lite/bcf';
import { rebindReviewModels, reviewScope } from './context';
import type { ReviewContext, ReviewFinding } from './types';

export interface ReviewPickingHost {
  /** Restore without animation, apply captured visibility/clipping, then await presented frames. */
  restore(viewpoint: BCFViewpoint): Promise<void>;
  /** CSS canvas size. Signature must include camera, visibility, cuts, model and mutation identity. */
  frame(): { width: number; height: number; signature: string };
  /** Renderer.pick uses CSS coordinates relative to the canvas; include current visibility options. */
  pick(x: number, y: number): Promise<{ expressId: number } | null>;
  currentModels(): Promise<ReviewContext['models']>;
  /** Tests may inject the native boundary; production defaults to canonical viewer resolution. */
  resolvePick?(globalId: number): Promise<ReviewContext['elements'][number] | null>;
}

async function resolveNativePick(globalId: number): Promise<ReviewContext['elements'][number] | null> {
  const [{ useViewerStore }, { resolveEntityRef, resolveEntityRefGlobalIdFromState }, { resolveGlobalId }] = await Promise.all([
    import('@/store'), import('@/store/resolveEntityRef'), import('@/lib/actions/resolve-global-id'),
  ]);
  const state = useViewerStore.getState();
  const ref = resolveEntityRef(globalId);
  const ifcGlobalId = resolveEntityRefGlobalIdFromState(state, ref);
  if (!ifcGlobalId) return null;
  const exact = resolveGlobalId(state, { modelId: ref.modelId, globalId: ifcGlobalId });
  if (typeof exact === 'string' || exact.expressId !== ref.expressId) return null;
  return { ...ref, ifcGlobalId };
}

/** A vision coordinate suggests where to pick; only the renderer establishes element identity. */
export async function createPickedFinding(finding: ReviewFinding, host: ReviewPickingHost, signal?: AbortSignal): Promise<ReviewFinding> {
  signal?.throwIfAborted();
  const point = finding.location;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new Error('This finding has no valid normalized screenshot point');
  }
  const viewpoint = finding.context.viewpoint;
  if (!viewpoint.snapshot) throw new Error('This finding has no saved screenshot to locate the suggested point');
  const aspect = viewpoint.perspectiveCamera?.aspectRatio ?? viewpoint.orthogonalCamera?.aspectRatio;
  if (typeof aspect !== 'number' || !Number.isFinite(aspect) || aspect <= 0) throw new Error('Saved screenshot has no camera aspect ratio; capture the view again before picking');
  const before = await host.currentModels();
  if (await reviewScope(before) !== finding.context.scopeId) throw new Error('Load the exact reviewed model revisions before picking');
  rebindReviewModels(finding.context.models, before);
  signal?.throwIfAborted();
  await host.restore(structuredClone(viewpoint));
  signal?.throwIfAborted();
  const frame = host.frame();
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0 || !frame.signature) {
    throw new Error('The restored viewer frame is unavailable');
  }
  if (Math.abs(frame.width / frame.height / aspect - 1) > 0.005) throw new Error('Viewer aspect ratio differs from the saved screenshot; restore its layout or capture again');
  // [0,1] includes the last image pixel, while canvas pick coordinates exclude width/height.
  const hit = await host.pick(Math.min(point.x * frame.width, frame.width - 0.001), Math.min(point.y * frame.height, frame.height - 0.001));
  signal?.throwIfAborted();
  if (!hit || !Number.isSafeInteger(hit.expressId) || hit.expressId < 1) throw new Error('No IFC element was hit at this screenshot point; the observation remains unbound');
  const element = await (host.resolvePick ?? resolveNativePick)(hit.expressId);
  const after = await host.currentModels();
  const latest = host.frame();
  signal?.throwIfAborted();
  if (latest.signature !== frame.signature || latest.width !== frame.width || latest.height !== frame.height ||
    JSON.stringify(after) !== JSON.stringify(before)) throw new Error('The model or viewer frame changed while picking; inspect again');
  if (!element || !element.ifcGlobalId || !after.some(model => model.id === element.modelId) || !Number.isSafeInteger(element.expressId) || element.expressId < 1) {
    throw new Error('The native hit has no exact IFC model and GlobalId identity; it cannot authorize an edit');
  }
  return { ...structuredClone(finding), id: crypto.randomUUID(), parentId: finding.id, createdAt: new Date().toISOString(),
    context: { ...structuredClone(finding.context), models: after, elements: [element],
      viewpoint: { ...structuredClone(viewpoint), guid: crypto.randomUUID(), components: {
        ...structuredClone(viewpoint.components), selection: [{ ifcGuid: element.ifcGlobalId }],
      } } } };
}
