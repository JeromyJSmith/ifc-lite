/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewContext } from '@/lib/review-companion/types';

export interface FastReviewTourHost {
  /** Finite motion budget; default 240 moves, at most 360. */
  maxMoves?: number;
  /** Capture and persist the exact frozen context before resolving. */
  capture(): Promise<ReviewContext>;
  inspect(context: ReviewContext, signal: AbortSignal): Promise<{ candidates: number }>;
  /** Complete one visible camera move (the host controls its animation duration). */
  move(step: number, signal: AbortSignal): Promise<void>;
}
export interface FastReviewTourState {
  running: boolean; status: string; pending: number; completed: number;
  outcome: 'completed' | 'interrupted' | 'failed' | null;
}
export interface FastReviewTourCapture {
  id: number; view: number; context: ReviewContext;
  status: 'queued' | 'analysing' | 'completed' | 'interrupted' | 'failed';
  result?: { candidates: number }; error?: string;
}

/** Bounded camera producer and independent serial image consumer. No timer
 * drives inference and no later screenshot replaces a queued captured view. */
export function createFastReviewTour(host: FastReviewTourHost, onState?: (state: FastReviewTourState) => void) {
  const maxMoves = host.maxMoves ?? 240;
  if (!Number.isSafeInteger(maxMoves) || maxMoves < 1 || maxMoves > 360) throw new Error('Tour move budget must be an integer from 1 to 360');
  const retained: FastReviewTourCapture[] = [];
  let state: FastReviewTourState = { running: false, status: 'Tour stopped', pending: 0, completed: 0, outcome: null };
  let controller: AbortController | null = null;
  let task: Promise<void> | null = null;
  let nextId = 1;
  const publish = (patch: Partial<FastReviewTourState>) => { state = { ...state, ...patch }; onState?.({ ...state }); };
  function stop() {
    if (controller && !controller.signal.aborted) { controller.abort(); publish({ status: 'Stopping motion and saved-view analysis…' }); }
  }
  function start(): Promise<void> {
    if (task) return task;
    const owner = new AbortController(); controller = owner;
    const signal = owner.signal;
    const queue: FastReviewTourCapture[] = [];
    let active: FastReviewTourCapture | null = null;
    let worker: Promise<void> | null = null;
    let producerDone = false, captured = 0, completed = 0, candidates = 0;
    let failure: string | null = null;
    function progress() {
      const pending = queue.length + (active ? 1 : 0);
      const status = signal.aborted ? (failure ? `Tour stopped: ${failure}` : 'Stopping motion and saved-view analysis…')
        : active ? `${producerDone ? 'Tour motion complete' : 'Live tour'}; analysing saved view ${active.view} (${queue.length} waiting)`
        : producerDone ? 'Tour motion complete; saved views analysed' : `Live tour; ${captured} views captured, ${completed} analysed`;
      publish({ running: true, pending, completed, status });
    }
    function launchConsumer() {
      if (worker || signal.aborted || !queue.length) return;
      worker = (async () => {
        while (queue.length && !signal.aborted) {
          const entry = queue.shift()!;
          active = entry; entry.status = 'analysing'; progress();
          try {
            const result = await host.inspect(structuredClone(entry.context), signal);
            if (!Number.isSafeInteger(result.candidates) || result.candidates < 0) throw new Error('Saved-view analysis returned an invalid finding count');
            // A real completed result is retained even if Stop arrived at its boundary.
            entry.result = { ...result }; entry.status = 'completed'; completed++; candidates += result.candidates;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            entry.status = signal.aborted ? 'interrupted' : 'failed'; entry.error = message;
            if (!signal.aborted) { failure = message; owner.abort(); }
          } finally { active = null; progress(); }
        }
      })().finally(() => {
        worker = null;
        // A producer can enqueue just as the consumer becomes idle.
        if (queue.length && !signal.aborted) launchConsumer();
      });
    }
    publish({ running: true, status: 'Starting live tour', pending: 0, completed: 0, outcome: null });
    task = (async () => {
      // Establish task ownership before any host callback can throw synchronously.
      await Promise.resolve();
      try {
        for (let step = 0; step < maxMoves && !signal.aborted && captured < 12 && candidates < 5; step++) {
          await host.move(step, signal);
          if (signal.aborted) break;
          // Backpressure limits retained in-flight work, never camera motion.
          if (queue.length + (active ? 1 : 0) < 2 && candidates < 5) {
            const context = await host.capture();
            const entry: FastReviewTourCapture = { id: nextId++, view: ++captured,
              context: structuredClone(context), status: signal.aborted ? 'interrupted' : 'queued' };
            retained.push(entry);
            if (!signal.aborted) { queue.push(entry); launchConsumer(); }
          }
          progress();
        }
        producerDone = true; progress();
        while (worker) await worker;
      } catch (error) {
        if (!signal.aborted) { failure = error instanceof Error ? error.message : String(error); owner.abort(); }
        producerDone = true;
        while (worker) await worker;
      } finally {
        for (const entry of queue) entry.status = 'interrupted';
        queue.length = 0;
        const status = failure ? `Tour stopped: ${failure}` : signal.aborted
          ? `Tour stopped; ${completed} saved views analysed. Captures remain available.`
          : `Tour finished; ${completed} saved views analysed, ${candidates} candidate findings. Captures remain available.`;
        publish({ running: false, pending: 0, completed, status, outcome: failure ? 'failed' : signal.aborted ? 'interrupted' : 'completed' });
        if (controller === owner) controller = null;
        task = null;
      }
    })();
    return task;
  }
  return { start, stop, state: () => ({ ...state }), snapshot: () => structuredClone(retained) };
}

export function useFastReviewTour(options: FastReviewTourHost & { active: boolean }) {
  const live = useRef(options); live.current = options;
  const mounted = useRef(true);
  const [state, setState] = useState<FastReviewTourState>({ running: false, status: 'Tour stopped', pending: 0, completed: 0, outcome: null });
  const engine = useRef<ReturnType<typeof createFastReviewTour> | null>(null);
  if (!engine.current) engine.current = createFastReviewTour({
    maxMoves: options.maxMoves,
    capture: () => live.current.capture(), inspect: (context, signal) => live.current.inspect(context, signal),
    move: (step, signal) => live.current.move(step, signal),
  }, next => { if (mounted.current) setState(next); });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; engine.current?.stop(); }; }, []);
  useEffect(() => { if (!options.active) engine.current?.stop(); }, [options.active]);
  const getState = useCallback(() => engine.current!.state(), []);
  const start = useCallback(() => {
    if (!live.current.active || !mounted.current) return Promise.reject(new DOMException('Review tour is no longer active', 'AbortError'));
    return engine.current!.start();
  }, []);
  return { ...state, start, getState, stop: () => engine.current!.stop() };
}
