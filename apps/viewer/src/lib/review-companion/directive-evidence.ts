/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { ReviewContext } from './types';

/** Already-captured native identities avoid a model round trip just to discover a model ID. */
export function directiveEvidence(context: ReviewContext, supplied?: unknown) {
  return { currentViewer: {
    capturedAt: context.capturedAt, mutationVersion: context.mutationVersion,
    models: context.models.map(({ id, name, sourceIdentity }) => ({ id, name, sourceIdentity })),
    selectedElements: context.elements, viewpointId: context.viewpoint.guid,
  }, ...(supplied === undefined ? {} : { savedIssueEvidence: supplied }) };
}
