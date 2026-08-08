/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The results panel and this dialog both group clashes with `groupClashes`, and
 * both let the user pick the mode. If they were independent, a user looking at
 * "one issue per affected element" on screen would silently export spatial
 * clusters instead. The dialog therefore OPENS on whatever the panel is showing
 * — and stays overridable from its own selector, which is right there.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import type { ClashResult } from '@ifc-lite/clash';
import { ClashBcfExportDialog, CLASH_GROUPINGS } from './ClashBcfExportDialog.js';

/** A minimal non-empty result: the dialog only needs something to preview. */
function oneClashResult(): ClashResult {
  const point: [number, number, number] = [0, 0, 0];
  return {
    clashes: [
      {
        id: 'c1',
        a: { key: 'beam', ref: 1, model: 'm1', tag: 'IfcBeam', name: 'Beam' },
        b: { key: 'wall', ref: 2, model: 'm1', tag: 'IfcWall', name: 'Wall' },
        rule: 'all-clashes',
        status: 'hard',
        distance: -0.05,
        point,
        bounds: { min: point, max: point },
        severity: 'major',
      },
    ],
    summary: {
      total: 1,
      byRule: { 'all-clashes': 1 },
      byTypePair: { 'IfcBeam|IfcWall': 1 },
      bySeverity: { critical: 0, major: 1, minor: 0, info: 0 },
    },
    rulesRun: [{ id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' }],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderDialog(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ClashBcfExportDialog />);
  });
  mounted.push({ root, container });
  return container;
}

/** Radix renders the dialog in a portal, so look in the whole document. */
function openDialog(container: HTMLElement): void {
  const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('BCF'));
  assert.ok(trigger instanceof HTMLButtonElement, 'expected a BCF export trigger button');
  act(() => {
    trigger.click();
  });
}

describe('ClashBcfExportDialog opens on the grouping the panel is showing', () => {
  beforeEach(() => {
    useViewerStore.setState({ clashResult: oneClashResult(), clashIssueGroupBy: 'cluster' });
  });

  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    useViewerStore.setState({ clashResult: null, clashIssueGroupBy: 'cluster' });
  });

  it('shows the panel\'s issue grouping as the export grouping', () => {
    useViewerStore.setState({ clashIssueGroupBy: 'element' });
    const container = renderDialog();
    openDialog(container);

    const label = CLASH_GROUPINGS.find((g) => g.key === 'element')?.label;
    assert.ok(label, 'fixture sanity: `element` must be one of the offered groupings');
    assert.ok(
      document.body.textContent?.includes(label),
      `expected the export dialog to open on "${label}"; got: ${document.body.textContent}`,
    );
  });

  it('still defaults to spatial clusters when the panel is grouping by cluster', () => {
    const container = renderDialog();
    openDialog(container);

    const clusterLabel = CLASH_GROUPINGS[0].label;
    assert.equal(CLASH_GROUPINGS[0].key, 'cluster', 'fixture sanity: cluster is the first offered grouping');
    assert.ok(
      document.body.textContent?.includes(clusterLabel),
      'the unchanged default must still open on spatial clustering',
    );
  });
});
