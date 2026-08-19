/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `raw-step-format.ts` carries two doc-comments asserting parity with
 * `@ifc-lite/export`'s private STEP-literal helpers:
 *
 *   - `splitTopLevelArgs` here has "same semantics as `splitTopLevelArgs` in
 *     `@ifc-lite/export`"
 *   - `serializeStepToken` here "Mirrors `serializeStepValue` in
 *     `@ifc-lite/export`"
 *
 * Neither claim held under adversarial input (checked empirically, not read
 * by eye — see LTplus-AG/ifc-lite investigation, 2026-08-19):
 *
 *   1. `splitTopLevelArgs`: a top-level TRAILING comma (`"a,"`, `","`) is kept
 *      as an extra empty argument here, but dropped by the export package's
 *      copy. Effect on a user: the Raw STEP tab's `extractRawStepTokens` (which
 *      calls this function) would render one phantom empty token past the
 *      last real argument for any entity whose body text has a trailing
 *      comma — the export package's copy, which is what a slot index is
 *      actually validated against elsewhere in the codebase, does not see
 *      that slot at all.
 *   2. `serializeStepToken`'s number branch is a bare `String(value)`, while
 *      `serializeStepValue`'s non-integer branch runs through `toStepReal` /
 *      `formatStepReal`, which rewrites the exponent to a STEP-legal
 *      uppercase `E` and forces a mantissa decimal point (`5e-8` -> `5.E-8`).
 *      Effect on a user: a positional override whose value is a very small or
 *      very large REAL (sub-micron / astronomical coordinates, scientific
 *      notation from a pasted CAD value) displays with a lowercase `e` in the
 *      Raw STEP tab even though the exporter — the documented source of truth
 *      for what reaches disk — would never write that token; the preview
 *      lies about the on-disk form.
 *   3. `serializeStepToken`'s string branch only escapes the quote character.
 *      `serializeStepValue` additionally doubles backslashes and collapses
 *      C0 control characters (newline, tab, ...) to a space. Effect on a
 *      user: an overlay string value containing a literal backslash or an
 *      embedded newline/tab renders unescaped/uncollapsed in the Raw STEP
 *      preview, again diverging from what the exporter actually emits.
 *
 * The export package is authoritative for all three (it is what ships to
 * disk, and it is the tested side — `step-serialization.test.ts`,
 * `step-argument-parser.test.ts`). This file does NOT change either
 * implementation — a fix wasn't attempted because it wasn't asked for and
 * the safer move is pinning today's (diverging) behaviour so the next
 * silent drift between the two copies is caught here instead of by a user
 * staring at a Raw STEP preview that doesn't match their exported file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcAttributeValue } from '@ifc-lite/mutations';

import {
  splitTopLevelArgs as splitTopLevelArgsViewer,
  serializeStepToken,
  parseRawStepInput,
} from './raw-step-format.js';
// Reaches past the export package's public entry point on purpose: these two
// helpers are deliberately NOT exported from `@ifc-lite/export`'s index (see
// the doc-comment on `splitTopLevelArgs` in raw-step-format.ts — "kept inline
// here to avoid leaking a private util across the package boundary"). A
// parity test has to see the real private implementation to be worth
// anything, so it takes the one path that can: a relative import into the
// other package's source tree.
import { splitTopLevelArgs as splitTopLevelArgsExport } from '../../../../../../packages/export/src/step-argument-parser.js';
import { serializeStepValue } from '../../../../../../packages/export/src/step-serialization.js';

describe('splitTopLevelArgs: viewer copy vs @ifc-lite/export copy', () => {
  const agreeingInputs = [
    ['', []],
    ['a', ['a']],
    ['a,b,c', ['a', 'b', 'c']],
    ['a,,b', ['a', '', 'b']],
    [',a', ['', 'a']],
    ["'a,b',c", ["'a,b'", 'c']],
    ["'it''s',c", ["'it''s'", 'c']],
    ['(1,2),(3,4)', ['(1,2)', '(3,4)']],
    ["'unterminated", ["'unterminated"]],
    ['((a,b)', ['((a,b)']],
    ['a))', ['a))']],
    ["'nested (paren, comma)',x", ["'nested (paren, comma)'", 'x']],
    ['  a  ,  b  ', ['a', 'b']],
    ["'\\X\\41\\X0\\',x", ["'\\X\\41\\X0\\'", 'x']],
    ["'\\X2\\00E9\\X0\\',x", ["'\\X2\\00E9\\X0\\'", 'x']],
    ["'a''''b',c", ["'a''''b'", 'c']],
    ['$,*,.T.', ['$', '*', '.T.']],
  ] as const;

  for (const [input, expected] of agreeingInputs) {
    it(`agree on ${JSON.stringify(input)}`, () => {
      assert.deepEqual(splitTopLevelArgsViewer(input), [...expected]);
      assert.deepEqual(splitTopLevelArgsExport(input), [...expected]);
    });
  }

  // DIVERGENT — pinned, not fixed. A trailing top-level comma produces an
  // extra empty argument in the viewer copy but not in the export copy.
  it('DIVERGES on a trailing top-level comma ("a,")', () => {
    assert.deepEqual(splitTopLevelArgsViewer('a,'), ['a', '']);
    assert.deepEqual(splitTopLevelArgsExport('a,'), ['a']);
  });

  it('DIVERGES on a bare comma (",")', () => {
    assert.deepEqual(splitTopLevelArgsViewer(','), ['', '']);
    assert.deepEqual(splitTopLevelArgsExport(','), ['']);
  });
});

describe('serializeStepToken (viewer) vs serializeStepValue (@ifc-lite/export)', () => {
  const agreeingValues: Array<[IfcAttributeValue, string]> = [
    [null, '$'],
    [true, '.T.'],
    [false, '.F.'],
    [0, '0'],
    [1, '1'],
    [-1, '-1'],
    [100, '100'],
    [0.001, '0.001'],
    [-0.35, '-0.35'],
    [3.14159, '3.14159'],
    [1e-6, '0.000001'],
    [1e-5, '0.00001'],
    ['plain', "'plain'"],
    ["it's a test", "'it''s a test'"],
    ['#42', '#42'],
    ['.AREA.', '.AREA.'],
    ['$', '$'],
    ['*', '*'],
    ['', "''"],
    ['  spaced  ', "'  spaced  '"],
    [[1, 2, [3, "a'b"]], "(1,2,(3,'a''b'))"],
  ];

  for (const [value, expected] of agreeingValues) {
    it(`agree on ${JSON.stringify(value)}`, () => {
      assert.equal(serializeStepToken(value), expected);
      assert.equal(serializeStepValue(value), expected);
    });
  }

  // DIVERGENT — pinned, not fixed. Non-integer REALs outside [1e-6, 1e21)
  // serialize through `toStepReal` on the export side (uppercase `E`, forced
  // mantissa decimal point) but through bare `String()` on the viewer side.
  it('DIVERGES on a small-magnitude REAL (1.5e-7)', () => {
    assert.equal(serializeStepToken(1.5e-7), '1.5e-7');
    assert.equal(serializeStepValue(1.5e-7), '1.5E-7');
  });

  it('DIVERGES on a small-magnitude REAL (5e-8)', () => {
    assert.equal(serializeStepToken(5e-8), '5e-8');
    assert.equal(serializeStepValue(5e-8), '5.E-8');
  });

  // DIVERGENT — pinned, not fixed. The export side escapes backslashes and
  // collapses control characters (`escapeStepString`); the viewer side only
  // escapes the quote character.
  it('DIVERGES on a string containing a backslash', () => {
    assert.equal(serializeStepToken('back\\slash'), "'back\\slash'");
    assert.equal(serializeStepValue('back\\slash'), "'back\\\\slash'");
  });

  it('DIVERGES on a string containing a newline', () => {
    assert.equal(serializeStepToken('line1\nline2'), "'line1\nline2'");
    assert.equal(serializeStepValue('line1\nline2'), "'line1 line2'");
  });

  it('DIVERGES on a string containing a tab', () => {
    assert.equal(serializeStepToken('tab\there'), "'tab\there'");
    assert.equal(serializeStepValue('tab\there'), "'tab here'");
  });
});

/**
 * Internal round-trip: `parseRawStepInput` (write side) against
 * `serializeStepToken` (read side), worth pinning regardless of the
 * cross-package question — this is the contract the inline editor's users
 * actually depend on (type a value, see it redisplayed the same way).
 */
describe('parseRawStepInput <-> serializeStepToken round-trip', () => {
  const roundTrips: IfcAttributeValue[] = [
    null,
    true,
    false,
    0,
    1,
    -1,
    100,
    0.001,
    -0.35,
    3.14159,
    1.5e-7,
    'plain',
    "it's a test",
    '#42',
    '.AREA.',
    '*',
    '  spaced  ',
  ];

  for (const value of roundTrips) {
    it(`serializeStepToken -> parseRawStepInput recovers ${JSON.stringify(value)}`, () => {
      const token = serializeStepToken(value);
      const parsed = parseRawStepInput(token);
      assert.ok('value' in parsed, `expected a value, got ${JSON.stringify(parsed)}`);
      assert.deepEqual(parsed.value, value);
    });
  }

  // DIVERGENT — pinned, not fixed. The string "$" collides with the null
  // sentinel: `serializeStepToken('$')` returns the bare token `$` (its
  // sentinel-passthrough branch treats an already-canonical `$`/`*` string as
  // pass-through rather than re-quoting it), and `parseRawStepInput('$')`
  // reads that token back as `null`. Effect on a user: typing the literal
  // string value `$` into the inline editor, then reopening the row, shows an
  // empty/null value instead of the string `$` they entered — a real data
  // round-trip loss inside the viewer alone, independent of the export
  // package comparison above.
  it('DIVERGES (self, lossy): the string "$" round-trips to null', () => {
    const token = serializeStepToken('$');
    assert.equal(token, '$');
    const parsed = parseRawStepInput(token);
    assert.deepEqual(parsed, { value: null });
  });
});
