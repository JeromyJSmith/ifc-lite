/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `camera-projection.ts` had no test coverage at all before this file: a
 * coverage survey found `projectToScreen` unexercised by any test in the
 * package, and `fitToBounds` exercised only for its *rejection* path
 * (`camera-malformed-bounds-fit.test.ts` covers unusable AABBs) — never for
 * the pose it actually produces on a well-formed box.
 *
 * `projectToScreen` is checked against an independent pinhole-camera oracle
 * (view-space coordinates via dot products with the camera basis, then the
 * textbook `tan(fov/2)` projection), not by re-deriving the same
 * matrix-multiply the code under test performs. `fitToBounds` is checked
 * against the isometric-offset formula from its own doc comment, using an
 * AABB with a distinct, asymmetric size per axis so a dropped or
 * transposed axis would be caught.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import type { Vec3 } from './types.js';

const FOV_90 = Math.PI / 2; // tan(fov/2) = 1, keeps the oracle arithmetic simple

/**
 * Independent pinhole-camera oracle for `projectToScreen`. Computes the
 * view-space position by hand (dot products against the camera's own right/
 * up/forward basis) and applies the standard `tan(fovY/2)` perspective
 * formula — no shared code path with `CameraProjection.projectToScreen`,
 * which goes through the 4x4 view-projection matrix instead.
 */
function pinholeProject(
  eye: Vec3, target: Vec3, up: Vec3, fovY: number, aspect: number,
  point: Vec3, width: number, height: number,
): { x: number; y: number } | null {
  const fz = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
  const flen = Math.sqrt(fz.x * fz.x + fz.y * fz.y + fz.z * fz.z);
  const forward = { x: fz.x / flen, y: fz.y / flen, z: fz.z / flen };
  // right = forward x up, then up' = right x forward (Gram-Schmidt), matching
  // a standard right-handed camera basis.
  const rx = { x: forward.y * up.z - forward.z * up.y, y: forward.z * up.x - forward.x * up.z, z: forward.x * up.y - forward.y * up.x };
  const rlen = Math.sqrt(rx.x * rx.x + rx.y * rx.y + rx.z * rx.z);
  const right = { x: rx.x / rlen, y: rx.y / rlen, z: rx.z / rlen };
  const trueUp = { x: right.y * forward.z - right.z * forward.y, y: right.z * forward.x - right.x * forward.z, z: right.x * forward.y - right.y * forward.x };

  const rel = { x: point.x - eye.x, y: point.y - eye.y, z: point.z - eye.z };
  const vx = rel.x * right.x + rel.y * right.y + rel.z * right.z;
  const vy = rel.x * trueUp.x + rel.y * trueUp.y + rel.z * trueUp.z;
  const vz = rel.x * forward.x + rel.y * forward.y + rel.z * forward.z; // distance along view axis

  if (vz <= 0) return null; // behind the camera

  const tanHalf = Math.tan(fovY / 2);
  const ndcX = vx / (vz * tanHalf * aspect);
  const ndcY = vy / (vz * tanHalf);
  return { x: (ndcX + 1) * 0.5 * width, y: (1 - ndcY) * 0.5 * height };
}

describe('CameraProjection.projectToScreen', () => {
  it('matches an independent pinhole oracle for an asymmetric off-axis point', () => {
    // Every coordinate distinct and non-zero, on both the camera pose and the
    // world point, so a swapped or dropped axis in the manual matrix multiply
    // would show up as a wrong pixel rather than cancelling out.
    const eye: Vec3 = { x: 5, y: 3, z: 20 };
    const target: Vec3 = { x: 1, y: -2, z: 0 };
    const up: Vec3 = { x: 0, y: 1, z: 0 };
    const worldPoint: Vec3 = { x: -4, y: 6, z: 2 };
    const width = 1600, height = 900;

    const camera = new Camera();
    camera.setAspect(width / height);
    camera.setFOV(FOV_90);
    camera.setPosition(eye.x, eye.y, eye.z);
    camera.setTarget(target.x, target.y, target.z);
    camera.setUp(up.x, up.y, up.z);

    const expected = pinholeProject(eye, target, up, FOV_90, width / height, worldPoint, width, height);
    assert.ok(expected, 'oracle expected a visible point');

    const actual = camera.projectToScreen(worldPoint, width, height);
    assert.ok(actual, 'projectToScreen returned null for a point in front of the camera');
    assert.ok(Math.abs(actual!.x - expected!.x) < 0.5, `x: got ${actual!.x}, oracle says ${expected!.x}`);
    assert.ok(Math.abs(actual!.y - expected!.y) < 0.5, `y: got ${actual!.y}, oracle says ${expected!.y}`);
  });

  it('projects the target to the exact centre of the canvas', () => {
    const camera = new Camera();
    camera.setAspect(4 / 3);
    camera.setPosition(10, 10, 10);
    camera.setTarget(2, 1, -3);
    const screen = camera.projectToScreen(camera.getTarget(), 800, 600);
    assert.ok(screen);
    assert.ok(Math.abs(screen!.x - 400) < 1e-3, `target x should be canvas centre, got ${screen!.x}`);
    assert.ok(Math.abs(screen!.y - 300) < 1e-3, `target y should be canvas centre, got ${screen!.y}`);
  });

  it('returns null for a point behind the camera', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setPosition(0, 0, 10);
    camera.setTarget(0, 0, 0);
    // Same side as the camera, further from the target: behind the eye.
    const behind = camera.projectToScreen({ x: 0, y: 0, z: 20 }, 1600, 900);
    assert.strictEqual(behind, null);

    // Anti-mutation: the symmetric point in front must still project.
    const front = camera.projectToScreen({ x: 0, y: 0, z: 0 }, 1600, 900);
    assert.ok(front, 'a point in front of the camera must still project');
  });

  it('returns null for a point outside the near/far clip volume in orthographic mode', () => {
    // Orthographic near/far are derived from `sceneBounds` by
    // `computeOrthoNearFar` (camera-matrices.ts): a small centred scene box
    // gives a near/far range close to the camera-to-scene distance, so a
    // point placed well outside that box along the view axis lands outside
    // the clip volume even though it is squarely in front of the camera.
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setProjectionMode('orthographic');
    camera.setSceneBounds({ min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } });
    camera.setPosition(0, 0, 20);
    camera.setTarget(0, 0, 0);

    // Near the scene's tight range (well within [near, far]): visible.
    const inRange = camera.projectToScreen({ x: 0, y: 0, z: 0 }, 1600, 900);
    assert.ok(inRange, 'a point inside the tight near/far range must project');

    // Far in front of the camera, past the tight far plane the scene bounds
    // produced: must be rejected rather than silently drawn.
    const beyondFar = camera.projectToScreen({ x: 0, y: 0, z: -500 }, 1600, 900);
    assert.strictEqual(beyondFar, null, 'a point far beyond the scene must be clipped, not drawn');
  });
});

describe('CameraProjection.fitToBounds', () => {
  it('matches the southeast-isometric formula from its own doc comment', () => {
    // A box with a distinct extent on every axis and an off-origin position,
    // so a transposed axis in `center`/`size`/`position` would be caught
    // rather than cancelling out against a cube or an origin-centred box.
    const min: Vec3 = { x: 0, y: 10, z: -5 };
    const max: Vec3 = { x: 6, y: 40, z: 15 }; // sizes: x=6, y=30 (max), z=20

    const camera = new Camera();
    camera.setAspect(16 / 9);
    // Pre-existing pose, to prove fitToBounds overwrites it rather than
    // blending with whatever was there before.
    camera.setPosition(999, 999, 999);
    camera.setTarget(999, 999, 999);

    camera.fitToBounds(min, max);

    const center = { x: 3, y: 25, z: 5 };
    const maxSize = 30; // y is the largest extent
    const distance = maxSize * 2.0;
    const expectedPosition = {
      x: center.x + distance * 0.6,
      y: center.y + distance * 0.5,
      z: center.z + distance * 0.6,
    };

    const gotTarget = camera.getTarget();
    const gotPosition = camera.getPosition();
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(Math.abs(gotTarget[axis] - center[axis]) < 1e-6, `target.${axis}: got ${gotTarget[axis]}, expected ${center[axis]}`);
      assert.ok(
        Math.abs(gotPosition[axis] - expectedPosition[axis]) < 1e-6,
        `position.${axis}: got ${gotPosition[axis]}, expected ${expectedPosition[axis]}`,
      );
    }
  });

  it('leaves the camera untouched on a degenerate (inverted) AABB', () => {
    const camera = new Camera();
    camera.setAspect(16 / 9);
    camera.setPosition(1, 2, 3);
    camera.setTarget(4, 5, 6);
    const before = { position: camera.getPosition(), target: camera.getTarget() };

    camera.fitToBounds({ x: Infinity, y: Infinity, z: Infinity }, { x: -Infinity, y: -Infinity, z: -Infinity });

    assert.deepStrictEqual(camera.getPosition(), before.position);
    assert.deepStrictEqual(camera.getTarget(), before.target);
  });
});
