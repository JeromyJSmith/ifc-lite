/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-check: STATUS_COLORS and STATUS_ICONS are two independent
 * `Record<string, string>` lookups keyed by the same BCF topic-status
 * domain. Both call sites (getStatusColor / the inline icon lookup in
 * updateMarkerInnerHTML) use `??` to fall back to a default when a status
 * is missing from the table, which means a key dropped from one table
 * silently renders a default color/icon instead of failing — the same
 * "disagree quietly" shape as the window-symbol mullion-count bug.
 */

import { describe, it, expect } from 'vitest';
import { STATUS_COLORS, STATUS_ICONS } from './overlay-renderer.js';

describe('overlay-renderer status tables', () => {
  it('STATUS_COLORS and STATUS_ICONS carry identical key sets', () => {
    const colorKeys = Object.keys(STATUS_COLORS).sort();
    const iconKeys = Object.keys(STATUS_ICONS).sort();

    const onlyInColors = colorKeys.filter((k) => !(k in STATUS_ICONS));
    const onlyInIcons = iconKeys.filter((k) => !(k in STATUS_COLORS));

    expect(onlyInColors, 'statuses with a color but no icon').toEqual([]);
    expect(onlyInIcons, 'statuses with an icon but no color').toEqual([]);
    expect(colorKeys).toEqual(iconKeys);
  });

  it('neither table has an empty-string value masquerading as a real entry', () => {
    for (const [status, color] of Object.entries(STATUS_COLORS)) {
      expect(color, `STATUS_COLORS['${status}']`).not.toBe('');
    }
    for (const [status, icon] of Object.entries(STATUS_ICONS)) {
      expect(icon, `STATUS_ICONS['${status}']`).not.toBe('');
    }
  });
});
