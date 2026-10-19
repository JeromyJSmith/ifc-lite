/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { Camera, Renderer } from '@ifc-lite/renderer';
import { captureViewportFrame } from '@/lib/viewport-capture';
import { createReviewTool } from './tools';

type Point = { x: number; y: number; z: number };
export interface SurfaceOrbitInput { x: number; y: number; azimuthDegrees: number; elevationDegrees: number }

/** Derive orbit angles from the actual eye offset, never the camera's roll-sensitive UI readout. */
export async function orbitSurface(camera: Camera, pivot: Point, azimuthDegrees: number, elevationDegrees: number) {
  const position = { ...camera.getPosition() }, target = { ...camera.getTarget() }, up = { ...camera.getUp() };
  const offset = { x: position.x - pivot.x, y: position.y - pivot.y, z: position.z - pivot.z };
  const radius = Math.hypot(offset.x, offset.y, offset.z);
  if (![...Object.values(pivot), ...Object.values(position), azimuthDegrees, elevationDegrees, radius].every(Number.isFinite) || radius < 1e-6) throw new Error('Surface orbit requires a finite surface in front of the camera.');
  const azimuth = Math.atan2(offset.x, offset.z) * 180 / Math.PI;
  const elevation = Math.asin(Math.max(-1, Math.min(1, offset.y / radius))) * 180 / Math.PI;
  camera.setTarget(pivot.x, pivot.y, pivot.z);
  camera.setRotation(azimuth + azimuthDegrees, elevation + elevationDegrees);
  const destination = { ...camera.getPosition() }, destinationUp = { ...camera.getUp() };
  camera.setPosition(position.x, position.y, position.z);
  camera.setTarget(target.x, target.y, target.z);
  camera.setUp(up.x, up.y, up.z);
  await camera.animateToWithUp(destination, pivot, destinationUp, 350);
  return { pivot, radius, position: { ...camera.getPosition() }, target: { ...camera.getTarget() } };
}

/** A current presented native hit supplies the pivot; no inferred or stale saved coordinates. */
export function createSurfaceOrbitTool(getRenderer: () => Renderer | null) {
  return createReviewTool('viewer_rotate_at', 'Visibly orbit around a surface at normalized CURRENT viewport coordinates x,y (0..1). Use the issue surface or its surroundings. Native picking must hit visible geometry; blank space is rejected. This keeps a close inspection anchored instead of using a distant BCF target. Does not edit geometry.', {
    x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
    azimuthDegrees: { type: 'number', minimum: -90, maximum: 90 }, elevationDegrees: { type: 'number', minimum: -45, maximum: 45 },
  }, false, async (input, context) => {
    const value = input as unknown as SurfaceOrbitInput, renderer = getRenderer();
    if (!renderer) throw new Error('Viewer camera is unavailable.');
    const camera = renderer.getCamera();
    const signature = () => JSON.stringify([camera.getPosition(), camera.getTarget(), camera.getUp(), camera.getProjectionMode(), camera.getOrthoSize()]);
    let frameSignature = '';
    const hit = await captureViewportFrame(renderer, { read: async (canvas, options) => {
      frameSignature = signature();
      const bounds = canvas.getBoundingClientRect(), x = value.x * bounds.width, y = value.y * bounds.height;
      const filters = { hiddenIds: options.hiddenIds, isolatedIds: options.isolatedIds };
      const surface = renderer.raycastScene(x, y, filters)?.intersection;
      const picked = await renderer.pick(x, y, filters);
      return surface && picked?.expressId === surface.expressId ? { expressId: surface.expressId, point: { ...surface.point } } : null;
    } });
    context?.signal?.throwIfAborted();
    if (!hit) throw new Error('No matching visible native surface at this image point. Choose a point on the issue surroundings. Camera was not moved.');
    if (signature() !== frameSignature) throw new Error('Camera changed during picking; retry against the current view.');
    const movement = await orbitSurface(camera, hit.point, value.azimuthDegrees, value.elevationDegrees);
    renderer.requestRender();
    return { ...movement, expressId: hit.expressId, coordinateSpace: 'rendered-viewer-world', geometryEdited: false };
  });
}
