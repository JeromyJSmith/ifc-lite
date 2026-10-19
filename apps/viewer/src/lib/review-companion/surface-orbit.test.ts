/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@ifc-lite/renderer';
import { orbitSurface, createSurfaceOrbitTool } from './surface-orbit';

function immediateCamera() {
  const camera = new Camera();
  const animate = camera.animateToWithUp.bind(camera);
  camera.animateToWithUp = (position, target, up) => animate(position, target, up, 0);
  return camera;
}

test('close surface orbit ignores a distant BCF target and roll-dependent azimuth', async () => {
  const camera = immediateCamera();
  camera.setPosition(0, 0, 2);
  camera.setTarget(0, 0, -31);
  camera.setUp(1, 0, 0); // UI rotation reports 270°, though eye offset around the hit is 0°.
  assert.equal(camera.getRotation().azimuth, 270);
  const result = await orbitSurface(camera, { x: 0, y: 0, z: 0 }, 20, 8);
  assert.equal(result.radius, 2);
  assert.deepEqual(camera.getTarget(), { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(camera.getDistance() - 2) < 1e-10);
  assert.ok(Math.abs(camera.getRotation().azimuth - 20) < 1e-10);
  assert.ok(Math.abs(camera.getRotation().elevation - 8) < 1e-10);
  assert.ok(Math.abs(camera.getPosition().x - 2 * Math.cos(8 * Math.PI / 180) * Math.sin(20 * Math.PI / 180)) < 1e-10);
});

test('orthographic surface orbit retains projection and visible scale', async () => {
  const camera = immediateCamera();
  camera.setPosition(3, 4, 5); camera.setTarget(0, 0, 0);
  camera.setProjectionMode('orthographic'); camera.setOrthoSize(0.75);
  await orbitSurface(camera, { x: 1, y: 2, z: 3 }, -15, -5);
  assert.equal(camera.getProjectionMode(), 'orthographic');
  assert.equal(camera.getOrthoSize(), 0.75);
  assert.ok(Math.abs(camera.getDistance() - Math.sqrt(12)) < 1e-10);
});

test('invalid or coincident native pivot leaves camera unchanged', async () => {
  const camera = immediateCamera();
  const before = JSON.stringify([camera.getPosition(), camera.getTarget(), camera.getUp()]);
  await assert.rejects(orbitSurface(camera, { x: NaN, y: 0, z: 0 }, 20, 0), /finite surface/);
  await assert.rejects(orbitSurface(camera, { ...camera.getPosition() }, 20, 0), /finite surface/);
  assert.equal(JSON.stringify([camera.getPosition(), camera.getTarget(), camera.getUp()]), before);
});

test('surface orbit tool rejects out-of-image points before accessing renderer', async () => {
  let accessed = false;
  const tool = createSurfaceOrbitTool(() => { accessed = true; return null; });
  await assert.rejects(tool.execute({ x: 1.1, y: 0.5, azimuthDegrees: 20, elevationDegrees: 0 }), /Invalid x/);
  assert.equal(accessed, false);
  await assert.rejects(tool.execute({ x: 0.5, y: 0.5, azimuthDegrees: 20, elevationDegrees: 0 }), /unavailable/);
});
