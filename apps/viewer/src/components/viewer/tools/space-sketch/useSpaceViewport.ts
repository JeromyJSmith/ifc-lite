/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Space Sketch canvas's view transform: fit/zoom/pan, the resizable
 * panel, and the pointer→world coordinate mapping. Owns no sketch/drawing
 * state — everything here is "where is the plan on screen", not "what is
 * drawn on it".
 *
 * `fitRef` MUST stay a ref (not state): it's read synchronously in ~10
 * places elsewhere in the overlay as `PICK_PX / fitRef.current.scale`
 * during pointer math, and an `underlayEls` memo there reads it while
 * depending on `fitTick` — so every write here keeps bumping `fitTick`
 * (via `applyFit` / the wheel + pan handlers) rather than only mutating the
 * ref, or that memo goes stale.
 *
 * `size`/`sizeRef` mirrors that split for the same reason: `sizeRef.current
 * = size` is a deliberate render-phase write, read synchronously by
 * `svgPoint` (below) and by the overlay's `computeFitFromPoints` calls — an
 * effect-deferred sync would leave the first pointer event after a resize
 * reading the stale size.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { computeFitFromPoints, zoomFit, PAD, type Fit, type Pt } from '@/lib/space-sketch-geometry';

const DEFAULT_W = 420;
const DEFAULT_H = 340;
const MIN_W = 320;
const MIN_H = 240;

export interface SpaceViewport {
  fitRef: React.RefObject<Fit>;
  size: { w: number; h: number };
  sizeRef: React.RefObject<{ w: number; h: number }>;
  fitTick: number;
  applyFit: (next: Fit) => void;
  fitToPoints: (pts: Pt[]) => void;
  /** Clamped canvas-local point for a pointer event (see the clamp note
   *  below — an unclamped drag past the panel edge once froze the browser). */
  svgPoint: (e: React.MouseEvent) => Pt;
  panningRef: React.RefObject<boolean>;
  /** Apply a raw pointer-movement delta (from `movementX`/`movementY`) as a
   *  pan. Used while `panningRef.current` is true. */
  panBy: (dx: number, dy: number) => void;
  /** Pointer handlers for the resize grip in the panel's corner. */
  resizeHandlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
  };
}

export function useSpaceViewport(svgRef: React.RefObject<SVGSVGElement | null>): SpaceViewport {
  const fitRef = useRef<Fit>({ scale: 1, offX: PAD, offY: DEFAULT_H - PAD });
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [fitTick, setFitTick] = useState(0);
  const applyFit = useCallback((next: Fit) => { fitRef.current = next; setFitTick((t) => t + 1); }, []);
  const fitToPoints = useCallback((pts: Pt[]) => {
    applyFit(computeFitFromPoints(pts, sizeRef.current.w, sizeRef.current.h));
  }, [applyFit]);

  const panningRef = useRef(false); // Issue 4: middle-mouse / empty-drag panning
  const panBy = useCallback((dx: number, dy: number) => {
    fitRef.current = { scale: fitRef.current.scale, offX: fitRef.current.offX + dx, offY: fitRef.current.offY + dy };
    setFitTick((t) => t + 1);
  }, []);

  // Wheel = zoom about the cursor (Issue 4). A native non-passive listener so
  // preventDefault() actually stops the page from scrolling under the panel.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015); // scroll up → zoom in
      const next = zoomFit(fitRef.current, factor, e.clientX - rect.left, e.clientY - rect.top);
      if (next.scale >= 0.5 && next.scale <= 5000) { fitRef.current = next; setFitTick((t) => t + 1); }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [svgRef]);

  const svgPoint = useCallback((e: React.MouseEvent): Pt => {
    const rect = svgRef.current!.getBoundingClientRect();
    // Clamp to the canvas: during a drag the pointer is captured, so moving it
    // past the panel (e.g. dragging a vertex down off the bottom) would report
    // coordinates far outside the SVG → a huge off-screen world position. That
    // pushed the room off-canvas ("disappears") and made the SVG rasterise a
    // polygon spanning to extreme coordinates, freezing the browser.
    return [
      Math.max(0, Math.min(sizeRef.current.w, e.clientX - rect.left)),
      Math.max(0, Math.min(sizeRef.current.h, e.clientY - rect.top)),
    ];
  }, []);

  const resizeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const resizeHandlers = {
    onPointerDown: useCallback((e: React.PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      resizeRef.current = { x: e.clientX, y: e.clientY, w: sizeRef.current.w, h: sizeRef.current.h };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }, []),
    onPointerMove: useCallback((e: React.PointerEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      setSize({ w: Math.max(MIN_W, Math.round(r.w + (e.clientX - r.x))), h: Math.max(MIN_H, Math.round(r.h + (e.clientY - r.y))) });
    }, []),
    onPointerUp: useCallback((e: React.PointerEvent) => {
      resizeRef.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }, []),
  };

  return { fitRef, size, sizeRef, fitTick, applyFit, fitToPoints, svgPoint, panningRef, panBy, resizeHandlers };
}
