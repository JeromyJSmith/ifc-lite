/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Thin React wiring around `space-bake.ts`'s pure bake core: reads the
 * overlay's per-storey sessions + drafted rooms at the active boundary mode,
 * dedupes against existing AUTHORED spaces, and creates every storey's draft
 * as real `IfcSpace` in one call. See `space-bake.ts` for the actual logic —
 * this hook only supplies the live refs/store bindings `bakeAllStoreys`
 * needs and keeps `generatedRef` (this tool's previously-created ids, so a
 * re-confirm REPLACES rather than duplicates) in sync.
 */

import { useCallback } from 'react';
import { useViewerStore } from '@/store';
import { existingSpaceFootprintsByStorey, type BoundaryMode } from '@ifc-lite/create';
import type { IfcDataStore } from '@ifc-lite/parser';
import { bakeAllStoreys, type BakeDeps, type DraftRoom, type StoreySession } from './space-bake';
import type { SpacePlateSession } from '@/lib/space-plate-session';
import type { Pt } from '@/lib/space-sketch-geometry';

interface UseSpaceBakeArgs {
  sketchModelId: string | null;
  ifcDataStore: IfcDataStore | null;
  boundaryMode: BoundaryMode;
  sessionsRef: React.RefObject<Map<number, SpacePlateSession>>;
  generatedRef: React.RefObject<Map<number, number[]>>;
  floorToFloor: (sid: number) => number;
}

export interface BakeAllOutcome { emitted: number; floors: number; error: string | null }

export function useSpaceBake({
  sketchModelId, ifcDataStore, boundaryMode, sessionsRef, generatedRef, floorToFloor,
}: UseSpaceBakeArgs): {
  createAllSpaces: () => BakeAllOutcome;
  revealSpaces: () => void;
} {
  /**
   * IfcSpace is class-hidden by default (TYPE_VISIBILITY_SEMANTIC_DEFAULTS).
   * Flip the toggle on after creating spaces so the user sees what they just
   * created — and, since the toggle persists, so the spaces stay visible
   * when the exported file is reopened.
   */
  const revealSpaces = useCallback(() => {
    const s = useViewerStore.getState();
    if (!s.typeVisibility.spaces) s.toggleTypeVisibility('spaces');
  }, []);

  /**
   * Turn EVERY storey's collected draft into IfcSpace at once — the single
   * create path, run on close/confirm. Reads each per-storey session's rooms
   * at the active boundary mode and dedupes against existing authored
   * spaces.
   */
  const createAllSpaces = useCallback((): BakeAllOutcome => {
    // Report a real error rather than a silent zero: the caller treats a
    // null error as success and closes the tool, which would discard every
    // draft the user has drawn. `sketchModelId` is genuinely reachable as
    // null — with several models loaded and none active we deliberately
    // refuse to guess which one to author into, rather than picking an
    // arbitrary one.
    if (!sketchModelId) {
      return { emitted: 0, floors: 0, error: 'No active model — pick one in the model list, then confirm again.' };
    }
    if (!ifcDataStore) {
      return { emitted: 0, floors: 0, error: 'Model data is still loading — confirm again in a moment.' };
    }
    const modelId = sketchModelId;
    const store = useViewerStore.getState();
    const authoredMap = existingSpaceFootprintsByStorey(ifcDataStore);
    const sessions: Map<number, StoreySession> = sessionsRef.current;
    const deps: BakeDeps = { removeEntity: store.removeEntity, addSpace: store.addSpace };
    const roomsFor = (sid: number): DraftRoom[] => {
      const session = sessionsRef.current.get(sid);
      if (!session) return [];
      return session.rooms().map((r) => ({
        outline: r.outline,
        boundary: session.boundaryOutline(r.face, boundaryMode) as Pt[],
      }));
    };
    const result = bakeAllStoreys(
      sessions, modelId, authoredMap, roomsFor, floorToFloor,
      (sid) => generatedRef.current.get(sid) ?? [],
      deps,
    );
    // `bakeStorey` always replaces the storey's previously-generated ids with
    // whatever it just emitted (even an empty list, if every room deduped
    // against an authored space) — matches the pre-extraction inline code.
    for (const [sid, ids] of result.perStorey) generatedRef.current.set(sid, ids);
    if (result.emitted > 0) revealSpaces();
    return { emitted: result.emitted, floors: result.floors, error: result.error };
  }, [sketchModelId, ifcDataStore, boundaryMode, sessionsRef, generatedRef, floorToFloor, revealSpaces]);

  return { createAllSpaces, revealSpaces };
}
