/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Direct unit coverage for the two boundary helpers in `numeric.ts`.
 *
 * `malformed-numeric.test.ts` already exercises these functions'
 * *consequences* through the reader, viewpoint conversions and the overlay —
 * but it never imports `numeric.ts` itself, so no test pins the helpers'
 * own contract at the function boundary (what a given raw string or distance
 * maps to). That is the tested-sibling asymmetry: every downstream consumer
 * has tests, the boundary function does not. These tests close that gap.
 */

import { describe, it, expect } from 'vitest';
import { parseFiniteFloat, usableTargetDistance } from './numeric.js';

describe('parseFiniteFloat', () => {
  it('parses an ordinary decimal', () => {
    expect(parseFiniteFloat('3.14')).toBe(3.14);
  });

  it('parses integers without gaining a decimal point', () => {
    expect(parseFiniteFloat('42')).toBe(42);
    expect(Number.isInteger(parseFiniteFloat('42'))).toBe(true);
  });

  it('parses a leading-dot fraction', () => {
    expect(parseFiniteFloat('.5')).toBe(0.5);
  });

  it('reports the literal "NaN" as undefined, not as NaN', () => {
    // This is the whole point of the module: a naive caller comparing
    // parseFloat's result against a tolerance would see `NaN > 0` silently
    // evaluate to false and let a garbage value through.
    expect(parseFiniteFloat('NaN')).toBeUndefined();
  });

  it('reports "1e999" as undefined, not as Infinity', () => {
    // "1e999" is a well-formed decimal literal a real exporter could write
    // for a runaway coordinate; parseFloat alone turns it into Infinity.
    expect(parseFiniteFloat('1e999')).toBeUndefined();
  });

  it('reports "-1e999" as undefined, not as -Infinity', () => {
    // Same family as above but the negative branch — a guard written
    // `!Number.isNaN(...)` alone would let this one through.
    expect(parseFiniteFloat('-1e999')).toBeUndefined();
  });

  it('reports the literal "Infinity" as undefined', () => {
    expect(parseFiniteFloat('Infinity')).toBeUndefined();
  });

  it('reports the literal "-Infinity" as undefined', () => {
    expect(parseFiniteFloat('-Infinity')).toBeUndefined();
  });

  it('reports an empty string as undefined', () => {
    expect(parseFiniteFloat('')).toBeUndefined();
  });

  it('reports non-numeric garbage as undefined', () => {
    expect(parseFiniteFloat('abc')).toBeUndefined();
  });

  it('keeps zero as a usable finite value', () => {
    // Zero is a legitimate coordinate; it must not be conflated with the
    // "not a number" family that maps to undefined.
    expect(parseFiniteFloat('0')).toBe(0);
  });

  it('preserves negative zero rather than normalising it to +0', () => {
    // Pinning current behaviour: -0 is finite, so it survives as -0, not 0.
    // Downstream consumers treat it as equal to 0 arithmetically, but a
    // test that only checked `=== 0` would not notice if the sign flipped.
    const result = parseFiniteFloat('-0');
    expect(result === 0).toBe(true); // numerically equal to zero
    expect(Object.is(result, -0)).toBe(true); // but the sign bit is preserved
  });

  it('parses a legitimately tiny magnitude (1e-300) without loss', () => {
    expect(parseFiniteFloat('1e-300')).toBe(1e-300);
  });

  it('parses a legitimately huge but finite magnitude (1e300)', () => {
    expect(parseFiniteFloat('1e300')).toBe(1e300);
  });

  it('mirrors parseFloat leading/trailing-whitespace handling', () => {
    expect(parseFiniteFloat('  42  ')).toBe(42);
  });

  it('mirrors parseFloat prefix parsing of a trailing non-numeric suffix', () => {
    // Documented `parseFloat` behaviour: it parses as much of a leading
    // numeric prefix as it can and ignores the rest. `parseFiniteFloat`
    // does not add stricter validation on top of this.
    expect(parseFiniteFloat('42abc')).toBe(42);
  });
});

describe('usableTargetDistance', () => {
  const fallback = 25;

  it('uses a positive finite distance verbatim', () => {
    expect(usableTargetDistance(5, fallback)).toBe(5);
  });

  it('accepts the smallest positive finite distance at the >0 boundary', () => {
    // Test at the threshold itself, not just comfortably above it.
    expect(usableTargetDistance(Number.MIN_VALUE, fallback)).toBe(Number.MIN_VALUE);
  });

  it('falls back for exactly zero', () => {
    // Zero is the degenerate pose (target collapsed onto the eye) that
    // `getDistance()` reports for a camera that was never positioned.
    expect(usableTargetDistance(0, fallback)).toBe(fallback);
  });

  it('falls back for negative zero', () => {
    // -0 is finite and `Number.isFinite(-0)` is true, but `-0 > 0` is
    // false, so it must fall back exactly like +0 does.
    expect(usableTargetDistance(-0, fallback)).toBe(fallback);
  });

  it('falls back for a negative distance', () => {
    expect(usableTargetDistance(-5, fallback)).toBe(fallback);
  });

  it('falls back for NaN', () => {
    // The input a broken pose actually supplies. `NaN > 0` is false, so a
    // comparison-only guard (without Number.isFinite) would also reject
    // this one — but the next two cases show why isFinite is still needed.
    expect(usableTargetDistance(NaN, fallback)).toBe(fallback);
  });

  it('falls back for Infinity', () => {
    expect(usableTargetDistance(Infinity, fallback)).toBe(fallback);
  });

  it('falls back for -Infinity', () => {
    // -Infinity > 0 is false, so this alone doesn't prove Number.isFinite
    // is load-bearing, but it is one of the three unusable values the
    // module's own comment calls out (NaN, Infinity, -Infinity).
    expect(usableTargetDistance(-Infinity, fallback)).toBe(fallback);
  });

  it('falls back for undefined', () => {
    expect(usableTargetDistance(undefined, fallback)).toBe(fallback);
  });

  it('never returns the fallback for a genuinely usable distance', () => {
    // Anti-mutation guard: if the function ignored `distance` entirely and
    // always returned `fallback`, every "uses distance verbatim" case above
    // would still pass by coincidence unless fallback happened to equal the
    // distance. Pin that a usable distance and a different fallback diverge.
    expect(usableTargetDistance(200, fallback)).not.toBe(fallback);
    expect(usableTargetDistance(200, fallback)).toBe(200);
  });
});
