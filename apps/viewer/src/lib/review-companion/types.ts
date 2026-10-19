/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { BCFViewpoint } from '@ifc-lite/bcf';

/** Screenshot position normalized to [0,1], with origin at its top-left. */
export interface ReviewPoint { x: number; y: number }

export interface ReviewContext {
  scopeId: string;
  models: Array<{ id: string; name: string; sourceIdentity: string }>;
  elements: Array<{ modelId: string; expressId: number; ifcGlobalId: string | null }>;
  viewpoint: BCFViewpoint;
  capturedAt: string;
  /** Native overlay revision at image capture; absent only in legacy archives. */
  mutationVersion?: number;
}

export interface ReviewFinding {
  schemaVersion: 1;
  id: string;
  context: ReviewContext;
  kind: 'note' | 'candidate';
  text: string;
  createdAt: string;
  provider?: { model: string; endpoint: string };
  parentId?: string;
  /** A visual location is not an IFC element identity until native picking resolves it. */
  location?: ReviewPoint;
  /** Native rendered surface evidence; viewer coordinates include active placements/recentering. */
  surfaceHit?: { point: { x: number; y: number; z: number }; triangleIndex: number; coordinateSpace: 'rendered-viewer-world'; };
}

/** Status changes append events; the original finding is never rewritten. */
export interface ReviewEvent {
  schemaVersion: 1;
  id: string;
  findingId: string;
  status: 'confirmed' | 'dismissed' | 'resolved';
  createdAt: string;
}

export interface ReviewArchive {
  schemaVersion: 1;
  scopeId: string;
  exportedAt: string;
  findings: ReviewFinding[];
  events: ReviewEvent[];
}
