/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ENTITY_NAME_ALIASES` (this package) and `get_legacy_entity_info`
 * (`rust/core/src/legacy_entities.rs`) are two independent, hand-maintained
 * tables. Nothing enforces they agree — and they have already disagreed once
 * (#2883 added `IFCELECTRICALDISTRIBUTIONPOINT` to this side after the two
 * were found to diverge). This test reads and parses the Rust source
 * directly (there is no built artefact to import across the language
 * boundary) and checks agreement mechanically instead of by eye.
 *
 * The two tables are NOT meant to hold identical key sets. Rust's table maps
 * every legacy IFC2x3/IFC4 name that has no `IfcType` enum variant, including
 * names — StandardCase/ElementedCase/Style variants, `IFCPROXY`,
 * `IFCBUILDINGELEMENT`, `IFCEQUIPMENTELEMENT`, … — that TS already resolves
 * directly because they exist as real entities in one of the bundled
 * `ENTITIES_IFC2X3`/`ENTITIES_IFC4`/`ENTITIES_IFC4X3` tables (see
 * `ENTITY_INFO_BY_UPPER` in `ifc-schema.ts`). Only Rust rows whose source
 * name is absent from ALL THREE bundled tables are in scope for TS's alias
 * table — for that subset, the two sides must agree on both the key set and
 * the target.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import { ENTITY_NAME_ALIASES } from './ifc-schema.js';

const rustPath = fileURLToPath(
    new URL('../../../rust/core/src/legacy_entities.rs', import.meta.url),
);

/** Parse `"NAME" => Some(LegacyEntityInfo { base_type: IfcType::Target, ...` arms. */
function parseRustLegacyEntities(source: string): Map<string, string> {
    const re = /"([A-Z0-9_]+)"\s*=>\s*Some\(LegacyEntityInfo\s*\{\s*base_type:\s*IfcType::(\w+),/g;
    const map = new Map<string, string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
        map.set(m[1], m[2]);
    }
    return map;
}

const rustSource = readFileSync(rustPath, 'utf8');
const rustTable = parseRustLegacyEntities(rustSource);

const bundledEntityNamesUpper = new Set<string>(
    [...ENTITIES_IFC2X3, ...ENTITIES_IFC4, ...ENTITIES_IFC4X3].map((e) => e.name.toUpperCase()),
);

describe('ENTITY_NAME_ALIASES / legacy_entities.rs parity', () => {
    it('parses a non-trivial number of rows out of legacy_entities.rs', () => {
        // Sanity check on the parser itself: if the Rust file's match-arm
        // shape ever changes, this regex should fail loudly here rather than
        // silently parsing zero rows and passing the rest of the suite for
        // the wrong reason.
        expect(rustTable.size).toBeGreaterThanOrEqual(20);
    });

    it('every TS alias source name is absent from all three bundled ENTITIES_* tables', () => {
        // If a name IS present in a bundled table, ENTITY_INFO_BY_UPPER
        // already resolves it directly and it should not be aliased here —
        // an entry for it would be redundant with (and could silently
        // override) the entity's own, more specific inheritance chain.
        for (const name of Object.keys(ENTITY_NAME_ALIASES)) {
            expect(bundledEntityNamesUpper.has(name), `${name} is already a real bundled entity`).toBe(false);
        }
    });

    const rustOnlyScope = [...rustTable.entries()].filter(([name]) => !bundledEntityNamesUpper.has(name));

    it('the Rust rows in TS scope (source name absent from every bundled table) is non-empty', () => {
        // Guards the fixture itself: if this ever empties out, the two loops
        // below would vacuously pass.
        expect(rustOnlyScope.length).toBeGreaterThan(0);
    });

    for (const [name, target] of rustOnlyScope) {
        it(`TS mirrors Rust's ${name} -> ${target}`, () => {
            expect(ENTITY_NAME_ALIASES[name], `${name} missing from ENTITY_NAME_ALIASES`).toBe(target);
        });
    }

    for (const [name, target] of Object.entries(ENTITY_NAME_ALIASES)) {
        it(`Rust mirrors TS's ${name} -> ${target}`, () => {
            expect(rustTable.get(name), `${name} missing from legacy_entities.rs`).toBe(target);
        });
    }
});
