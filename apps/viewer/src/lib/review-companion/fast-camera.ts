/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';
import type { ReviewContext } from './types';

/** An explicit user-started camera route; no model inference is needed for each move. */
export function createFastCameraRoute(renderer: Renderer, stops: ReviewContext[], restore: (context: ReviewContext) => Promise<void>) {
  const camera = renderer.getCamera(), original = { position: { ...camera.getPosition() }, target: { ...camera.getTarget() }, rotation: { ...camera.getRotation() } };
  return async (step: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (step < stops.length) {
      await restore(stops[step]);
      signal.throwIfAborted(); return;
    }
    const before = { ...camera.getPosition() }, beforeTarget = { ...camera.getTarget() }, target = { ...original.target };
    camera.setPosition(original.position.x, original.position.y, original.position.z);
    camera.setTarget(target.x, target.y, target.z);
    camera.setRotation(original.rotation.azimuth + (step - stops.length + 0.5) * 45, Math.max(-80, Math.min(80, original.rotation.elevation + (step % 2 ? -6 : 6))));
    const rotated = { ...camera.getPosition() }, factor = step % 3 === 0 ? 1.2 : 1;
    const destination = { x: target.x + (rotated.x - target.x) / factor, y: target.y + (rotated.y - target.y) / factor, z: target.z + (rotated.z - target.z) / factor };
    camera.setPosition(before.x, before.y, before.z); camera.setTarget(beforeTarget.x, beforeTarget.y, beforeTarget.z);
    await camera.animateTo(destination, target, 350); renderer.requestRender();
    signal.throwIfAborted();
  };
}
