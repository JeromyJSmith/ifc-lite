/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { create } from 'zustand';

/** Cover the complete user action, including saving and native BCF projection
 * after inference finishes. Synchronous acquisition prevents a second click
 * from starting another action before React has rendered disabled controls. */
export class ReviewActionBusyError extends Error {
  constructor() { super('Wait for the current review action and its saved result to finish.'); this.name = 'ReviewActionBusyError'; }
}
export function createReviewActionGate(setBusy: (busy: boolean) => void) {
  let running = false;
  return async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (running) throw new ReviewActionBusyError();
    running = true;
    try {
      setBusy(true);
      return await operation();
    } finally {
      running = false;
      setBusy(false);
    }
  };
}

// Like the Assistant's composer draft, this is runtime-only state outside the
// panel: moving between BCF and Assistant must not allow a second overlapping
// action while the first panel's persistence is still finishing.
export const useReviewActionState = create<{ busy: boolean; error: string }>(() => ({ busy: false, error: '' }));
const sharedGate = createReviewActionGate(busy => useReviewActionState.setState(busy ? { busy, error: '' } : { busy }));
export async function runReviewAction<T>(operation: () => Promise<T>): Promise<T> {
  try { return await sharedGate(operation); }
  catch (error) {
    if (!(error instanceof ReviewActionBusyError)) {
      const text = error instanceof Error ? error.message : String(error);
      useReviewActionState.setState({ error: /aborted|aborterror/i.test(text) || error instanceof Error && error.name === 'AbortError' ? '' : text });
    }
    throw error;
  }
}
