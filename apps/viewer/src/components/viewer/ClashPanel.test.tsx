/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `groupClashes({ by: 'cluster' })` (packages/clash/src/grouping.ts) already
 * collapses spatially-related element pairs into a smaller number of
 * coordination issues — measured on a real road/bridge model, 8 IfcBeam ×
 * IfcBeam pairs collapse into exactly 2 clusters (one per abutment). Before
 * this change, the viewer's `useClash` hook already computed this grouping
 * into `clashGroups` on every run (for the BCF export dialog), but
 * `ClashPanel` — the results list the user actually looks at — never
 * rendered it: the panel only ever showed the flat 8-pair list, with no way
 * to see "2 issues" anywhere.
 *
 * These tests render the real `ClashPanel` against a seeded store using the
 * REAL `groupClashes` (not a mock), so a failure here means the panel itself
 * doesn't surface the grouping — not that the grouping algorithm is broken
 * (that's covered in packages/clash).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { groupClashes, type Clash, type ClashElementRef, type ClashResult } from '@ifc-lite/clash';
import { ClashPanel } from './ClashPanel.js';

function ref(key: string, ref: number): ClashElementRef {
  return { key, ref, model: 'm1', tag: 'IfcBeam', name: key };
}

/** One clash between two beams, centred at `point`, all in the same rule + type-pair
 *  bucket so `groupClashes({ by: 'cluster' })` only splits on spatial distance. */
function beamClash(id: string, point: [number, number, number]): Clash {
  return {
    id,
    a: ref(`${id}-a`, id.charCodeAt(0) * 2),
    b: ref(`${id}-b`, id.charCodeAt(0) * 2 + 1),
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.05,
    point,
    bounds: { min: point, max: point },
    severity: 'major',
  };
}

/** 8 beam×beam pairs in two tight spatial clusters ~100 m apart — the
 *  measured motivating case: one cluster per bridge abutment. Well inside the
 *  default 1.5 m cluster epsilon within a cluster, far outside it between. */
function bridgeAbutmentResult(): ClashResult {
  const clashes: Clash[] = [
    beamClash('c1', [0, 0, 0]),
    beamClash('c2', [0.2, 0, 0]),
    beamClash('c3', [0, 0.3, 0]),
    beamClash('c4', [0.1, 0.1, 0.1]),
    beamClash('c5', [100, 0, 0]),
    beamClash('c6', [100.2, 0, 0]),
    beamClash('c7', [100, 0.3, 0]),
    beamClash('c8', [100.1, 0.1, 0.1]),
  ];
  return {
    clashes,
    summary: {
      total: clashes.length,
      byRule: { 'all-clashes': clashes.length },
      byTypePair: { 'IfcBeam|IfcBeam': clashes.length },
      bySeverity: { critical: 0, major: clashes.length, minor: 0, info: 0 },
    },
    rulesRun: [{ id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' }],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

/** One IfcBeam × IfcWall clash. The wall ref is SHARED across the clashes that
 *  hit the same wall, so `by: 'element'` can collect "every clash on this wall"
 *  — the grouping no radius can express. */
function beamWallClash(id: string, wall: string, point: [number, number, number]): Clash {
  return {
    id,
    a: { key: `${id}-beam`, ref: id.charCodeAt(1) * 4, model: 'm1', tag: 'IfcBeam', name: `Beam-${id}` },
    b: { key: wall, ref: wall.charCodeAt(5), model: 'm1', tag: 'IfcWall', name: wall },
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.05,
    point,
    bounds: { min: point, max: point },
    severity: 'major',
  };
}

/**
 * Six beams crossing two parallel walls — the measured case where spatial
 * clustering provably CANNOT produce "one issue per wall". Contact points along
 * one wall are 1.467 m apart, but the two walls are only 0.926 m apart, so any
 * radius large enough to link a wall's own clashes (≥1.467 m) also links across
 * the walls: there is no epsilon that yields the per-wall grouping, and at the
 * 1.5 m default all six collapse into ONE cluster. `by: 'element'` yields it
 * directly (one group per wall, plus one per beam).
 */
function beamsCrossingTwoWallsResult(): ClashResult {
  const clashes: Clash[] = [
    beamWallClash('c1', 'Wall-1', [0, 0, 0]),
    beamWallClash('c2', 'Wall-1', [1.467, 0, 0]),
    beamWallClash('c3', 'Wall-1', [2.934, 0, 0]),
    beamWallClash('c4', 'Wall-2', [0, 0.926, 0]),
    beamWallClash('c5', 'Wall-2', [1.467, 0.926, 0]),
    beamWallClash('c6', 'Wall-2', [2.934, 0.926, 0]),
  ];
  return {
    clashes,
    summary: {
      total: clashes.length,
      byRule: { 'all-clashes': clashes.length },
      byTypePair: { 'IfcBeam|IfcWall': clashes.length },
      bySeverity: { critical: 0, major: clashes.length, minor: 0, info: 0 },
    },
    rulesRun: [{ id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' }],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

// `@tanstack/react-virtual` measures the scroll container's real
// `offsetHeight` to decide which rows are in the visible range; happy-dom
// (no real layout engine) always reports 0, so with no stub every virtualized
// row silently fails to render — the panel would look empty regardless of
// what's under test. Give it a plausible viewport once, globally.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderPanel(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ClashPanel />);
  });
  mounted.push({ root, container });
  return container;
}

function resetStore(): void {
  useViewerStore.setState({
    clashResult: null,
    clashGroups: null,
    clashSelectedId: null,
    clashSortBy: 'severity',
    clashHideTouching: false,
    clashStatusFilter: new Set(['open', 'resolved', 'accepted']),
    clashIssueGroupBy: 'cluster',
  });
}

/** The panel's issue-grouping mode selector — identified by its options, since
 *  the toolbar also carries a sort selector. */
function issueModeSelect(container: HTMLElement): HTMLSelectElement | undefined {
  return [...container.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'element'),
  );
}

/** Group-header rows currently rendered in the results list. */
function groupHeaders(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll('button[aria-expanded]')].filter((b) =>
    /^(Collapse|Expand) /.test(b.getAttribute('aria-label') ?? ''),
  ) as HTMLButtonElement[];
}

/** A group header renders its title then its member count, so the title comes
 *  from `aria-label` and the count is whatever text follows it. */
function headerInfo(b: HTMLButtonElement): { label: string; count: number } {
  const label = (b.getAttribute('aria-label') ?? '').replace(/^(Collapse|Expand) /, '');
  return { label, count: Number((b.textContent ?? '').slice(label.length)) };
}

/** Collect `console.error` output (where React reports list-key collisions)
 *  until `stop()` is called, which restores the real console. */
function captureConsoleErrors(): { stop: () => string[] } {
  const messages: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  };
  return {
    stop: () => {
      console.error = real;
      return messages;
    },
  };
}

async function showIssues(container: HTMLElement): Promise<void> {
  const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Issues');
  assert.ok(toggle instanceof HTMLButtonElement, 'expected an "Issues" view toggle button');
  await act(async () => {
    toggle.click();
  });
}

describe('ClashPanel surfaces the existing clash grouping as coordination issues', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    resetStore();
  });

  it('shows the clustered issue count (2), not just the 8-pair total, once a result with groups is loaded', () => {
    const result = bridgeAbutmentResult();
    const groups = groupClashes(result, { by: 'cluster' }); // epsilon defaults to 1.5 m
    assert.equal(groups.length, 2, 'fixture sanity: 8 pairs must cluster into exactly 2 groups at the default epsilon');

    useViewerStore.setState({ clashResult: result, clashGroups: groups });
    const container = renderPanel();

    // The 8-pair total must still be visible (RED-safe: this already passes today).
    assert.ok(container.textContent?.includes('8'), 'the raw pair total (8) must still be shown');

    // The issue count (2) must ALSO be surfaced somewhere in the panel — this is
    // the behavior under test, and is what fails before the fix.
    const text = container.textContent ?? '';
    const mentionsTwoIssues = /\b2\b[^0-9]{0,20}issue/i.test(text) || /issue[^0-9]{0,20}\b2\b/i.test(text);
    assert.ok(mentionsTwoIssues, `expected the panel to surface "2 issues" somewhere; got: ${text}`);
  });

  it('switching to the issues view lists 2 group rows, each expandable to its member pairs', async () => {
    const result = bridgeAbutmentResult();
    const groups = groupClashes(result, { by: 'cluster' });
    useViewerStore.setState({ clashResult: result, clashGroups: groups });
    const container = renderPanel();

    const issuesToggle = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Issues',
    );
    assert.ok(issuesToggle instanceof HTMLButtonElement, 'expected an "Issues" view toggle button');
    await act(async () => {
      issuesToggle.click();
    });

    // Two group header rows, each showing its member count (4 pairs each).
    const groupHeaders = [...container.querySelectorAll('button[aria-expanded]')].filter((b) =>
      /\b4\b/.test(b.textContent ?? ''),
    );
    assert.equal(groupHeaders.length, 2, 'expected two issue-group headers, each showing 4 member pairs');

    // Expanding one group must reveal its underlying pairs — the raw data is
    // NOT removed, only re-organized (requirement: pairs stay reachable).
    await act(async () => {
      (groupHeaders[0] as HTMLButtonElement).click();
    });
    const beamMentions = (container.textContent?.match(/IfcBeam/g) ?? []).length;
    assert.ok(beamMentions >= 4, 'expanding an issue group must reveal its member element pairs');
  });
});

/**
 * `groupClashes` offers four modes (cluster / rule / typePair / element) and BCF
 * export already lets the user pick among them — but the panel hardcoded
 * `by: 'cluster'`, the one mode that provably cannot express "one issue per
 * wall" on the fixture below. These tests pin the selector that exposes the
 * other three to the results list.
 */
describe('ClashPanel lets the user choose the issue grouping mode', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    resetStore();
  });

  it('fixture: cluster and element grouping give different counts, so the choice is not cosmetic', () => {
    const result = beamsCrossingTwoWallsResult();
    const clustered = groupClashes(result, { by: 'cluster' });
    const byElement = groupClashes(result, { by: 'element' });

    assert.equal(clustered.length, 1, 'at the 1.5 m default all six pairs collapse into a single cluster');
    // 2 walls + 6 beams. Two of those groups hold a whole wall's three clashes —
    // and no radius produces them: linking a wall's own clashes needs >= 1.467 m,
    // which already exceeds the 0.926 m between the two walls.
    assert.equal(byElement.length, 8, 'element grouping yields one group per participating element');
    assert.equal(
      byElement.filter((g) => g.members.length === 3).length,
      2,
      'element grouping must produce one 3-clash group per wall',
    );
    for (const eps of [0.5, 0.9, 0.926, 1, 1.467, 1.5, 2, 5]) {
      const groups = groupClashes(result, { by: 'cluster', epsilon: eps });
      const perWall = groups.filter((g) => g.members.length === 3).length;
      assert.notEqual(perWall, 2, `no radius should reproduce the per-wall grouping; epsilon=${eps} did`);
    }
  });

  it('offers the four groupClashes modes in the issues view and regroups the list when one is picked', async () => {
    const result = beamsCrossingTwoWallsResult();
    useViewerStore.setState({
      clashResult: result,
      clashGroups: groupClashes(result, { by: 'cluster' }),
    });
    // Under `element` grouping a clash belongs to BOTH participating elements'
    // groups, so a list key derived from the clash id alone collides and React
    // silently drops rows. React reports that on console.error — capture it for
    // the whole render/switch below.
    const keyWarnings = captureConsoleErrors();

    const container = renderPanel();
    await showIssues(container);

    // Default (cluster) is unchanged: one issue holding all six pairs.
    assert.equal(groupHeaders(container).length, 1, 'cluster mode must still show a single issue');

    const select = issueModeSelect(container);
    assert.ok(select instanceof HTMLSelectElement, 'expected a grouping-mode selector in the issues view');
    assert.deepEqual(
      [...select.options].map((o) => o.value),
      ['cluster', 'rule', 'typePair', 'element'],
      'the selector must offer exactly the four groupClashes modes BCF export offers',
    );

    await act(async () => {
      select.value = 'element';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // The headline count follows the chosen mode, not the run's cluster snapshot.
    // The headline number and its label are adjacent spans, so `textContent`
    // reads "8issues · 6 pairs" — no word boundary between the two.
    assert.match(
      container.textContent ?? '',
      /(?<!\d)8\s*issues/i,
      'the summary must report 8 issues once element grouping is chosen',
    );

    // The list itself is re-grouped: every rendered header is an element group.
    // (The list is virtualized, so not all 8 headers are in the DOM at once —
    // the count above is what pins the group total.)
    const headers = groupHeaders(container).map(headerInfo);
    assert.ok(headers.length > 1, 'element mode must split the single cluster into several issues');
    assert.ok(
      headers.every((h) => h.label.startsWith('Clashes on ')),
      `every issue must now be an element group; got ${JSON.stringify(headers.map((h) => h.label))}`,
    );
    const wallHeaders = headers.filter((h) => h.label.includes('IfcWall'));
    assert.equal(wallHeaders.length, 2, 'element mode must surface a per-wall issue for each wall');
    assert.deepEqual(
      wallHeaders.map((h) => h.count),
      [3, 3],
      'each per-wall issue must report its three member pairs — the grouping no radius can produce',
    );

    assert.deepEqual(
      keyWarnings.stop().filter((m) => /same key/i.test(m)),
      [],
      'a clash in two element groups must still get two distinct list keys',
    );
  });

  it('shows the cluster radius only while cluster grouping is actually in use', async () => {
    const result = beamsCrossingTwoWallsResult();
    useViewerStore.setState({
      clashResult: result,
      clashGroups: groupClashes(result, { by: 'cluster' }),
      clashClusterEpsilon: 1.5,
    });
    const container = renderPanel();
    await showIssues(container);

    const radiusShown = (): boolean => /1\.5\s*m/.test(container.textContent ?? '');
    assert.ok(radiusShown(), 'cluster mode must show the radius it is clustering at');

    const select = issueModeSelect(container);
    assert.ok(select instanceof HTMLSelectElement, 'expected a grouping-mode selector in the issues view');
    await act(async () => {
      select.value = 'element';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    assert.ok(
      !radiusShown(),
      'the cluster radius is meaningless under element grouping and must not be shown',
    );
  });
});
