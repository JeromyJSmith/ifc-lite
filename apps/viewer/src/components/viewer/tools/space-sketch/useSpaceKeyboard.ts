/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Space Sketch overlay's three keyboard listeners. Each is its own hook
 * so the calling component can keep them at their original positions in the
 * render body relative to the session-disposal effect — React runs unmount
 * cleanups in mount order, and while none of these listeners' cleanups
 * (they only `removeEventListener`) actually depend on that order today,
 * preserving it keeps this a pure move rather than a re-ordering.
 *
 * CAPTURE PHASE IS LOAD-BEARING on the two listeners below that use it: the
 * global handler in `useKeyboardShortcuts` registers `keydown` in bubble
 * phase; these listeners register with the capture flag (third argument
 * `true`) and Escape calls `stopImmediatePropagation()`. That is what stops
 * the first Esc from closing the whole tool via the global handler. Dropping
 * the third `true` argument — or the `stopImmediatePropagation()` — is a
 * one-character regression nothing else catches.
 */

import { useEffect } from 'react';
import { eventKey, isTextEntryTarget } from '@/lib/keyboard-event';
import { isRemoveModifier } from '@/lib/space-interaction';

/**
 * Ctrl/Cmd+Z (Shift = redo) must drive THIS overlay's history, not the 3D
 * model behind the panel. The global handler in useKeyboardShortcuts routes
 * Ctrl+Z to the active model's mutation stack; this capture-phase listener
 * runs before it and stopPropagation()s, so the sketch and the in-panel
 * Undo/Redo buttons share one history. Skip when a text input is focused so
 * native field undo (and the global handler, which also skips inputs) is
 * untouched. The overlay only mounts while the tool is active, so this
 * listener's lifetime is exactly the tool's.
 */
export function useUndoRedoKeys(undo: () => void, redo: () => void): void {
  useEffect(() => {
    const onUndoRedo = (e: KeyboardEvent) => {
      if (eventKey(e) !== 'z' || !(e.ctrlKey || e.metaKey)) return;
      if (isTextEntryTarget(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onUndoRedo, true);
    return () => window.removeEventListener('keydown', onUndoRedo, true);
  }, [undo, redo]);
}

export interface EscEnterKeysArgs {
  helpOpen: boolean;
  optionsOpen: boolean;
  setHelpOpen: (v: boolean) => void;
  setOptionsOpen: (v: boolean) => void;
  abortCurrentOp: () => boolean;
  escTimeRef: React.RefObject<number>;
  needsConfirm: boolean;
  closeNow: () => void;
  setStatus: (s: string) => void;
  drawPtsLength: number;
  commitDraw: () => void;
}

/**
 * While the panel is open, Esc belongs to the sketch — NOT the global
 * shortcut (which closes the tool and would lose the sketch). Esc: close a
 * popover/confirm → abort the current op → (double-tap) close, with an
 * unconfirmed-drafts guard. Enter closes a drawn room.
 */
export function useEscEnterKeys({
  helpOpen, optionsOpen, setHelpOpen, setOptionsOpen, abortCurrentOp, escTimeRef,
  needsConfirm, closeNow, setStatus, drawPtsLength, commitDraw,
}: EscEnterKeysArgs): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation(); // own Esc; don't let the global handler close us
        if (helpOpen || optionsOpen) { setHelpOpen(false); setOptionsOpen(false); return; }
        const now = Date.now();
        if (abortCurrentOp()) { escTimeRef.current = 0; return; }
        // Double-tap Esc cancels (close without creating); the Confirm button is
        // the only create path.
        if (now - escTimeRef.current <= 400) { escTimeRef.current = 0; closeNow(); }
        else { escTimeRef.current = now; setStatus(needsConfirm ? 'Esc again to close without creating (use Confirm to create).' : 'Press Esc again to close.'); }
      } else if (e.key === 'Enter' && drawPtsLength > 0 && !inField) {
        e.preventDefault();
        e.stopImmediatePropagation();
        commitDraw();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [abortCurrentOp, commitDraw, drawPtsLength, needsConfirm, closeNow, helpOpen, optionsOpen, escTimeRef, setHelpOpen, setOptionsOpen, setStatus]);
}

/**
 * Pressing/releasing a modifier re-evaluates the hover preview at the
 * current cursor (so the action label + cues flip the instant you hold
 * ⌥/Ctrl/Shift, without having to move). No-op until the cursor has been
 * over the canvas.
 *
 * `rafRef` here MUST be the same ref `onPointerMove` schedules
 * `processMove` with — this listener is the interaction code's SECOND
 * scheduler, guarded by the identical `if (rafRef.current == null)`
 * single-flight check. Two independent `rafRef`s would let both schedulers
 * queue a frame at once: two `processMove` runs per frame with no symptom
 * except the tool feeling heavier.
 */
export function useModifierRepaintKeys(
  processMove: () => void,
  moveRef: React.RefObject<{ x: number; y: number; shift: boolean; del: boolean } | null>,
  dragRef: React.RefObject<number | null>,
  panningRef: React.RefObject<boolean>,
  rafRef: React.RefObject<number | null>,
): void {
  useEffect(() => {
    const onMod = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' && e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Shift') return;
      const m = moveRef.current;
      if (!m || dragRef.current != null || panningRef.current) return;
      m.del = isRemoveModifier(e);
      m.shift = e.shiftKey;
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(processMove);
    };
    window.addEventListener('keydown', onMod);
    window.addEventListener('keyup', onMod);
    return () => { window.removeEventListener('keydown', onMod); window.removeEventListener('keyup', onMod); };
  }, [processMove, moveRef, dragRef, panningRef, rafRef]);
}
