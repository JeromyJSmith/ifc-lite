/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins the TS merger (`mergeInheritedPropertySets`) to the cross-language
 * vectors shared with the Rust merger (`merge_inherited` in
 * `rust/export/src/model_inherit.rs`, exercised by
 * `rust_merge_matches_shared_parity_vectors` in
 * `rust/export/src/model_inherit_tests.rs`), so the two implementations
 * cannot silently drift. Follows the `unit_symbol_vectors.json` /
 * `unit_symbol_parity.rs` / `project-units.parity.test.ts` pattern (issue
 * #1573) already used in this repo for cross-language parity.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mergeInheritedPropertySets } from '../src/property-set-merge.js';

const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/pset_merge_vectors.json', import.meta.url),
);

interface PropExpect {
  name: string;
  value: string;
}
interface SetExpect {
  name: string;
  properties: PropExpect[];
}
interface Case {
  name: string;
  own: SetExpect[];
  inherited: SetExpect[];
  expected: SetExpect[];
}

function shape(sets: SetExpect[]): Array<[string, Array<[string, string]>]> {
  return sets.map((s) => [s.name, s.properties.map((p) => [p.name, p.value])]);
}

describe.skipIf(!existsSync(fixturePath))('mergeInheritedPropertySets shared parity vectors', () => {
  const cases = existsSync(fixturePath)
    ? (JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: Case[] }).cases
    : [];

  it('fixture has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`matches the Rust merger: ${c.name}`, () => {
      const merged = mergeInheritedPropertySets(c.own, c.inherited);
      expect(shape(merged)).toEqual(shape(c.expected));
    });
  }
});
