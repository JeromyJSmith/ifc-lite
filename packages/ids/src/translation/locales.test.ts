/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-check: en.ts / de.ts / fr.ts are three parallel nested-key
 * translation tables that must carry identical key sets. TypeScript's
 * `Translations = typeof en` typing in service.ts only catches a missing
 * leaf at compile time if the property is accessed through a statically
 * typed path; the generic `t(key: string, ...)` lookup in service.ts
 * walks the object with `part in value` and falls back to returning the
 * raw dotted key string when a branch is missing — which means a locale
 * that's missing a key doesn't error, it renders the untranslated key
 * itself into the UI. This test asserts the three locale files carry the
 * exact same set of leaf key paths, independent of that fallback.
 */

import { describe, it, expect } from 'vitest';
import { en } from './locales/en.js';
import { de } from './locales/de.js';
import { fr } from './locales/fr.js';

/** Collect every leaf key path (dot-joined) in a nested plain-object tree. */
function leafKeyPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') {
    return [prefix];
  }
  const paths: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      paths.push(...leafKeyPaths(v, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

describe('IDS translation locales', () => {
  const locales: Record<string, Record<string, unknown>> = { en, de, fr };
  const keySets: Record<string, Set<string>> = Object.fromEntries(
    Object.entries(locales).map(([name, table]) => [name, new Set(leafKeyPaths(table))])
  );

  it('en, de, and fr expose identical leaf key sets', () => {
    const names = Object.keys(locales);
    for (const a of names) {
      for (const b of names) {
        if (a >= b) continue;
        const onlyInA = [...keySets[a]].filter((k) => !keySets[b].has(k));
        const onlyInB = [...keySets[b]].filter((k) => !keySets[a].has(k));
        expect(onlyInA, `keys present in ${a} but missing from ${b}`).toEqual([]);
        expect(onlyInB, `keys present in ${b} but missing from ${a}`).toEqual([]);
      }
    }
  });

  it('no locale has an empty-string value for a present key', () => {
    for (const [name, table] of Object.entries(locales)) {
      for (const path of leafKeyPaths(table)) {
        const parts = path.split('.');
        let value: unknown = table;
        for (const part of parts) value = (value as Record<string, unknown>)[part];
        expect(value, `${name}.${path}`).not.toBe('');
      }
    }
  });
});
