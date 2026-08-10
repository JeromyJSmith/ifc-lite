/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Behavioural pin for the Space Sketch overlay's Esc/Enter keyboard hook.
 * `SpaceSketchOverlay` itself can't mount under the node test harness (its
 * entry point suspends on `ensureSpaceWasm()`, which rejects there — see
 * #2438), so this exercises `useEscEnterKeys` directly through a tiny host
 * component, which is exactly what the overlay wires it into.
 *
 * The two things load-bearing here (both called out in useSpaceKeyboard.ts):
 * capture-phase registration + `stopImmediatePropagation()`, which is what
 * stops a bubble-phase global Esc handler (`useKeyboardShortcuts`) from
 * closing the whole tool on the FIRST Esc; and the double-tap-within-400ms
 * close gesture.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRef, useState } from 'react';
import { useEscEnterKeys } from './useSpaceKeyboard.js';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function Host({ onClose, abortCurrentOp }: { onClose: () => void; abortCurrentOp: () => boolean }) {
  const escTimeRef = useRef(0);
  const [helpOpen] = useState(false);
  const [optionsOpen] = useState(false);
  useEscEnterKeys({
    helpOpen, optionsOpen,
    setHelpOpen: () => {}, setOptionsOpen: () => {},
    abortCurrentOp, escTimeRef,
    needsConfirm: false, closeNow: onClose, setStatus: () => {},
    drawPtsLength: 0, commitDraw: () => {},
  });
  return null;
}

function mount(onClose: () => void, abortCurrentOp: () => boolean): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<Host onClose={onClose} abortCurrentOp={abortCurrentOp} />); });
  mounted.push({ root, container });
  return container;
}

function dispatchEscape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

describe('useEscEnterKeys', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => { root.unmount(); });
      container.remove();
    }
  });

  it('capture-phase-intercepts the FIRST Esc: a bubble-phase global listener never sees it, and the tool does not close', () => {
    const globalHandler = mock.fn();
    // Bubble phase (no `true` third argument) — matches useKeyboardShortcuts.
    window.addEventListener('keydown', globalHandler);
    try {
      const closeNow = mock.fn();
      mount(closeNow, () => false); // nothing to abort — falls through to the esc-timer branch
      dispatchEscape();
      assert.equal(globalHandler.mock.callCount(), 0, 'the capture-phase listener must stopImmediatePropagation before the bubble-phase global handler runs');
      assert.equal(closeNow.mock.callCount(), 0, 'a single Esc must not close the tool');
    } finally {
      window.removeEventListener('keydown', globalHandler);
    }
  });

  it('closes on the SECOND Esc within 400ms (double-tap-to-close)', () => {
    const closeNow = mock.fn();
    mount(closeNow, () => false);
    dispatchEscape();
    dispatchEscape();
    assert.equal(closeNow.mock.callCount(), 1);
  });

  it('a second Esc after 400ms does NOT close — it restarts the double-tap window instead', async () => {
    const closeNow = mock.fn();
    mount(closeNow, () => false);
    dispatchEscape();
    await new Promise((r) => setTimeout(r, 450));
    dispatchEscape();
    assert.equal(closeNow.mock.callCount(), 0);
  });

  it('when there is something to abort, Esc aborts it INSTEAD of counting toward double-tap-close', () => {
    const closeNow = mock.fn();
    let aborted = 0;
    mount(closeNow, () => { aborted++; return true; });
    dispatchEscape();
    dispatchEscape(); // would close if the first Esc had counted — it must not have
    assert.equal(aborted, 2, 'abortCurrentOp runs on every Esc while it keeps reporting something to abort');
    assert.equal(closeNow.mock.callCount(), 0);
  });
});
