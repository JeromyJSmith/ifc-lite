/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure "bake" core for the Space Sketch tool: turning a storey's drafted
 * rooms into real `IfcSpace`. No React, no wasm — reads a plate's already-
 * extracted rooms and calls the store mutators it's handed.
 *
 * `bakeStorey` mirrors the shape it had inline in `SpaceSketchOverlay`
 * (`sid, rooms, authored -> {emitted, skipped, error}`): a storey with a
 * generated-space id list to replace, the storey's drafted rooms (outline
 * for area/dedup, boundary for the emitted outline), and the model's
 * existing AUTHORED space footprints (to dedupe against). It never mutates
 * the plate — only reads rooms already extracted from it.
 */

import { centroid, pointInPoly, polyArea, type Pt } from '@/lib/space-sketch-geometry';
import { GENERATED_SPACE_OBJECTTYPE } from '@ifc-lite/create';

export type AddSpaceResult = { expressId: number } | { error: string };

export interface BakeDeps {
  removeEntity: (modelId: string, expressId: number) => void;
  addSpace: (
    modelId: string,
    storeyExpressId: number,
    params: {
      Profile: 'polygon';
      OuterCurve: Pt[];
      Height: number;
      Name: string;
      ObjectType: string;
      grossFloorArea: number;
    },
  ) => AddSpaceResult;
}

export interface DraftRoom {
  outline: Pt[];
  boundary: Pt[];
}

export interface BakeStoreyResult {
  emitted: number;
  skipped: number;
  error: string | null;
  newIds: number[];
}

/**
 * Bake one storey's drafted rooms into IfcSpace. (1) Replace: remove the
 * spaces this tool previously created on the storey (`previouslyGenerated`).
 * (2) Skip rooms that overlap an existing AUTHORED space (dedup). (3) Emit
 * each via `deps.addSpace`. An `addSpace` failure (anchor resolution,
 * missing mutation view, …) is NOT an "already a space" skip — the first
 * error is kept so the caller can report the truth instead of silently
 * dropping spaces that would then be missing from the export.
 */
export function bakeStorey(
  sid: number,
  modelId: string,
  rooms: DraftRoom[],
  authored: Pt[][],
  height: number,
  previouslyGenerated: number[],
  deps: BakeDeps,
): BakeStoreyResult {
  for (const id of previouslyGenerated) deps.removeEntity(modelId, id);
  const newIds: number[] = [];
  let skipped = 0;
  let error: string | null = null;
  for (const room of rooms) {
    const [cx, cy] = centroid(room.outline);
    if (authored.some((fp) => pointInPoly(cx, cy, fp))) { skipped++; continue; }
    // `boundary` is the engine's net/gross/centre outline; gross area stays on
    // the centreline so the quantity reflects the room, not the wall face.
    const res = deps.addSpace(modelId, sid, {
      Profile: 'polygon', OuterCurve: room.boundary, Height: height,
      Name: `Space ${newIds.length + 1}`, ObjectType: GENERATED_SPACE_OBJECTTYPE,
      grossFloorArea: polyArea(room.outline),
    });
    if (res && 'expressId' in res) newIds.push(res.expressId);
    else error ??= (res && 'error' in res ? res.error : 'unknown error');
  }
  return { emitted: newIds.length, skipped, error, newIds };
}

export interface StoreySession {
  alive: boolean;
  roomCount: number;
}

export interface BakeAllResult {
  emitted: number;
  floors: number;
  error: string | null;
  perStorey: Map<number, number[]>;
}

/**
 * Bake EVERY storey with a live, non-empty session — the single create path,
 * run on confirm. `sessions` and `roomsFor`/`heightFor` are read-only; the
 * caller supplies each storey's rooms already resolved at the active
 * boundary mode (the plate itself is never touched here).
 */
export function bakeAllStoreys(
  sessions: Map<number, StoreySession>,
  modelId: string,
  authoredMap: Map<number, Pt[][]>,
  roomsFor: (sid: number) => DraftRoom[],
  heightFor: (sid: number) => number,
  previouslyGeneratedFor: (sid: number) => number[],
  deps: BakeDeps,
): BakeAllResult {
  let emitted = 0, floors = 0;
  let firstError: string | null = null;
  const perStorey = new Map<number, number[]>();
  for (const [sid, session] of sessions) {
    if (!session.alive || session.roomCount === 0) continue;
    const res = bakeStorey(
      sid, modelId, roomsFor(sid), authoredMap.get(sid) ?? [], heightFor(sid),
      previouslyGeneratedFor(sid), deps,
    );
    perStorey.set(sid, res.newIds);
    emitted += res.emitted;
    if (res.emitted) floors++;
    firstError ??= res.error;
  }
  return { emitted, floors, error: firstError, perStorey };
}
