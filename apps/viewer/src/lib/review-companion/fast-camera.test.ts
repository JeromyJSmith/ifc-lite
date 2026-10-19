/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import { createFastCameraRoute } from './fast-camera';
import type { ReviewContext } from './types';

test('actual saved stops are visited first, then bounded smooth orbit/zoom uses the original anchor', async () => {
  let position = { x: 10, y: 5, z: 10 }, target = { x: 0, y: 0, z: 0 };
  const movements: unknown[] = [], restored: ReviewContext[] = [];
  const stops = [{ scopeId: 'fixture:outside' }, { scopeId: 'fixture:inside' }] as ReviewContext[];
  const camera = { getPosition: () => position, getTarget: () => target, getRotation: () => ({ azimuth: 45, elevation: 30 }),
    setPosition: (x: number, y: number, z: number) => { position = { x, y, z }; },
    setTarget: (x: number, y: number, z: number) => { target = { x, y, z }; },
    setRotation: (_azimuth: number, _elevation: number) => { position = { x: -10, y: 5, z: 10 }; },
    animateTo: async (p: typeof position, t: typeof target, duration: number) => { movements.push({ from: { ...position }, to: p, target: t, duration }); position = p; target = t; },
  };
  const renderer = { getCamera: () => camera, requestRender: () => {} } as unknown as Renderer;
  const move = createFastCameraRoute(renderer, stops, async context => { restored.push(context); position = { x: 1, y: 2, z: 3 }; });
  const signal = new AbortController().signal;
  await move(0, signal); await move(1, signal);
  assert.deepEqual(restored, stops); assert.equal(movements.length, 0);
  await move(2, signal);
  assert.deepEqual(movements[0], { from: { x: 1, y: 2, z: 3 }, to: { x: -10, y: 5, z: 10 }, target: { x: 0, y: 0, z: 0 }, duration: 350 });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(move(4, abort.signal), /abort/i);
  assert.equal(movements.length, 1);
});
