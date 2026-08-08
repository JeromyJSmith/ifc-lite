/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #2422 finding 3: `bim.clash.run`/`matrix`/`presets`/`disciplineRules`
 * declare `tsReturn: 'Promise<unknown>' | 'unknown[]'` in the generated
 * `.d.ts`, but every `call:` handler here delegates straight through to
 * `ClashNamespace`, which is typed `Promise<ClashResult>` / `ClashRule[]` on
 * the SDK side (packages/sdk/src/namespaces/clash.ts).
 *
 * This file drives the real `@ifc-lite/clash` engine through the bridge's
 * `call:` handlers (no mocking of `sdk.clash`) and asserts on the actual
 * runtime shape a script receives — `.clashes`, `.summary`, `.rulesRun`,
 * `.settings` on `run`/`matrix`, and rule-shaped objects from
 * `presets`/`disciplineRules`. It exists to pin that runtime shape so a
 * future fix to the declared `tsReturn` types (tracked in #2422) can be
 * checked against real behaviour rather than against the `.d.ts` under
 * suspicion, and so any accidental narrowing of what `sdk.clash` actually
 * returns gets caught here.
 */

import { describe, expect, it } from 'vitest';
import { ClashNamespace } from '@ifc-lite/sdk';
import type { BimContext, ClashElement, Vec3 } from '@ifc-lite/sdk';
import { buildClashNamespace } from './bridge-clash.js';

/** Axis-aligned cube as a triangle mesh (12 triangles), mirroring the clash package's own test fixture. */
function makeBox(center: Vec3, size: number): { positions: Float32Array; indices: Uint32Array } {
  const h = size / 2;
  const [cx, cy, cz] = center;
  const v: number[] = [
    cx - h, cy - h, cz - h,
    cx + h, cy - h, cz - h,
    cx + h, cy + h, cz - h,
    cx - h, cy + h, cz - h,
    cx - h, cy - h, cz + h,
    cx + h, cy - h, cz + h,
    cx + h, cy + h, cz + h,
    cx - h, cy + h, cz + h,
  ];
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ]);
  return { positions: new Float32Array(v), indices };
}

function boxElement(key: string, tag: string, center: Vec3): ClashElement {
  const { positions, indices } = makeBox(center, 1);
  const min: Vec3 = [center[0] - 0.5, center[1] - 0.5, center[2] - 0.5];
  const max: Vec3 = [center[0] + 0.5, center[1] + 0.5, center[2] + 0.5];
  return { key, ref: key.length, model: 'm', tag, bounds: { min, max }, positions, indices };
}

function findMethod(name: string) {
  const method = buildClashNamespace().methods.find((m) => m.name === name);
  if (!method) throw new Error(`no such method: ${name}`);
  return method;
}

/** A minimal BimContext stand-in whose `.clash` is the real SDK namespace — everything else is unused by these methods. */
function sdkWithRealClash(): BimContext {
  return { clash: new ClashNamespace() } as unknown as BimContext;
}

describe('bim.clash — runtime shape actually returned across the bridge (#2422 finding 3)', () => {
  it('run() resolves a ClashResult object, not an opaque unknown', async () => {
    // Two overlapping boxes: guaranteed to produce at least one clash.
    const elements = [boxElement('a', 'IfcWall', [0, 0, 0]), boxElement('b', 'IfcDuct', [0.4, 0, 0])];
    const rules = [{ id: 'r1', name: 'wall-vs-duct', a: 'IfcWall', b: 'IfcDuct', mode: 'hard' as const }];

    const result = await (findMethod('run').call(sdkWithRealClash(), [elements, rules, undefined]) as Promise<unknown>);

    // The declared tsReturn is `Promise<unknown>` — a script could not
    // usefully do any of this without a cast. Assert the concrete shape
    // ClashNamespace#run actually returns.
    expect(result).toMatchObject({
      clashes: expect.any(Array),
      summary: expect.objectContaining({ total: expect.any(Number) }),
      rulesRun: expect.any(Array),
      settings: expect.objectContaining({ tolerance: expect.any(Number) }),
    });
    const clashes = (result as { clashes: unknown[] }).clashes;
    expect(clashes.length).toBeGreaterThan(0);
    expect(clashes[0]).toMatchObject({
      a: expect.objectContaining({ key: 'a', tag: 'IfcWall' }),
      b: expect.objectContaining({ key: 'b', tag: 'IfcDuct' }),
      status: expect.any(String),
    });
  });

  it('matrix() resolves the same ClashResult shape as run()', async () => {
    const elements = [boxElement('a', 'IfcWall', [0, 0, 0]), boxElement('b', 'IfcDuct', [0.4, 0, 0])];

    const result = await (findMethod('matrix').call(sdkWithRealClash(), [elements, { mode: 'hard' }]) as Promise<unknown>);

    expect(result).toMatchObject({
      clashes: expect.any(Array),
      summary: expect.objectContaining({ total: expect.any(Number) }),
      rulesRun: expect.any(Array),
      settings: expect.any(Object),
    });
  });

  it('presets() returns concrete ClashRulePreset-shaped objects, not opaque unknown[] — NOT ClashRule[]', () => {
    // `presets()` and `disciplineRules()` are declared with the identical
    // `tsReturn: 'unknown[]'`, and the issue's finding (3) describes both as
    // "ClashRule[]". They are not the same shape at runtime: `presets()`
    // returns the raw discipline-pair descriptors (id/name/description/
    // severity/selectorA/selectorB), not runnable ClashRule objects — no
    // `mode`, and selectors are named `selectorA`/`selectorB`, not `a`/`b`.
    // A fix to finding (3) must give these two methods different concrete
    // return types, not the same `ClashRule[]`.
    const presets = findMethod('presets').call(sdkWithRealClash(), []) as unknown[];

    expect(Array.isArray(presets)).toBe(true);
    expect(presets.length).toBeGreaterThan(0);
    for (const preset of presets) {
      expect(preset).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        description: expect.any(String),
        severity: expect.any(String),
        selectorA: expect.any(String),
        selectorB: expect.any(String),
      });
      expect(preset).not.toHaveProperty('mode');
      expect(preset).not.toHaveProperty('a');
    }
  });

  it('disciplineRules() returns concrete ClashRule-shaped objects, not opaque unknown[]', () => {
    const rules = findMethod('disciplineRules').call(sdkWithRealClash(), ['hard']) as unknown[];

    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        a: expect.any(String),
        mode: 'hard',
      });
    }
  });
});
