/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import type { BCFViewpoint } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from './useBCF';
import { useFastReviewTour } from './useFastReviewTour';
import type { useReviewProcessJournal } from './useReviewProcessJournal';
import { createFastCameraRoute } from '@/lib/review-companion/fast-camera';
import { listFindings } from '@/lib/review-companion/storage';
import { reviewModels, reviewScope } from '@/lib/review-companion/context';
import { captureViewportFrame } from '@/lib/viewport-capture';
import { createReviewEventStream } from '@/lib/review-companion/ag-ui';
import { persistReviewJson } from '@/lib/review-companion/journal';
import type { ReviewContext, ReviewFinding } from '@/lib/review-companion/types';

type Options = {
  active: boolean; scope: string; connected: boolean; pauseObservation(): void;
  capture(): Promise<ReviewContext>;
  inspect(context: ReviewContext, signal: AbortSignal): Promise<{ candidates: number }>;
  persist(row: ReviewFinding): Promise<string>;
  applyViewpoint(viewpoint: BCFViewpoint, animate: boolean): void;
  process: ReturnType<typeof useReviewProcessJournal>;
};
export function useReviewFastMode(options: Options) {
  const live = useRef(options); live.current = options;
  const [stops, setStops] = useState<ReviewFinding[]>([]);
  const starting = useRef(false);
  const route = useRef<ReturnType<typeof createFastCameraRoute> | null>(null);
  const input = useRef<ReviewFinding | null>(null);
  const sourceModels = useRef(useViewerStore.getState().models);
  const stream = useRef<ReturnType<typeof createReviewEventStream> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listFindings(options.scope).then(rows => {
      if (!cancelled) setStops(rows.filter(row => !row.provider && row.text.startsWith('{"kind":"review.fast.stop"')));
    }).catch(error => console.error('Saved tour stops unavailable:', error));
    return () => { cancelled = true; };
  }, [options.scope]);
  const tour = useFastReviewTour({ active: options.active, maxMoves: 8,
    move: async (step, signal) => {
      const state = useViewerStore.getState();
      if (state.mutationVersion !== input.current?.context.mutationVersion) throw new Error('Model was edited; fast tour stopped.');
      if (state.models !== sourceModels.current) {
        if (await reviewScope(await reviewModels(state.models)) !== input.current?.context.scopeId) throw new Error('Loaded model revisions changed; fast tour stopped.');
        sourceModels.current = state.models;
      }
      if (!route.current) throw new Error('Camera route has not started.');
      await route.current(step, signal);
    },
    capture: async () => {
      const context = await live.current.capture();
      const id = crypto.randomUUID();
      await live.current.persist({ schemaVersion: 1, id, kind: 'note', context, text: JSON.stringify({ kind: 'review.fast.capture' }), createdAt: new Date().toISOString(), parentId: input.current!.id });
      await stream.current?.state({ capturedViewRef: id, message: 'Exact view queued for serial visual analysis; live navigation may continue.' });
      return context;
    },
    inspect: (context, signal) => live.current.inspect(context, signal),
  });
  return { ...tour, events: () => stream.current?.events() ?? [], isRunning: () => starting.current || tour.getState().running, stops: stops.length,
    addStop: async () => {
      const context = await options.capture();
      const row: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'note', context,
        text: JSON.stringify({ kind: 'review.fast.stop', label: `Tour view ${stops.length + 1}` }), createdAt: new Date().toISOString() };
      await options.persist(row); setStops(rows => [...rows, row]);
    },
    start: async () => {
      if (starting.current || tour.running) throw new Error('Fast tour is already running.');
      if (!options.connected) throw new Error('Connect Bonsai vision first.');
      starting.current = true; stream.current = null; options.pauseObservation();
      try {
        const context = await options.capture();
        const row: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'note', context, createdAt: new Date().toISOString(), text: 'Fast tour requested: navigate visibly, inspect saved views serially, and record up to five candidate issues. No IFC edits.' };
        await options.persist(row); input.current = row;
        if (options.process.current()?.status === 'running') await options.process.interrupt('Owner started a new fast tour.');
        const process = await options.process.begin(context, row.text, row.id);
        stream.current = createReviewEventStream({ threadId: context.scopeId, runId: process.id, onEvent: event =>
          persistReviewJson({ ...row, id: crypto.randomUUID(), parentId: row.id }, { kind: 'ag-ui.event', runId: process.id, event }, options.persist).then(() => undefined) });
        await stream.current.start();
        await stream.current.toolStart('fast-tour', 'viewer_fast_tour', { maxMoves: 8, maxCaptures: 12, maxPending: 2 });
        const renderer = getGlobalRenderer(); if (!renderer) throw new Error('Viewer camera is unavailable.');
        const currentState = useViewerStore.getState();
        if (currentState.mutationVersion !== context.mutationVersion || await reviewScope(await reviewModels(currentState.models)) !== context.scopeId) throw new Error('The reviewed model revision changed during tour setup.');
        sourceModels.current = currentState.models;
        const validStops = stops.filter(stop => stop.context.scopeId === context.scopeId && stop.context.mutationVersion === context.mutationVersion);
        route.current = createFastCameraRoute(renderer, validStops.map(stop => stop.context), async saved => {
          if (saved.scopeId !== await reviewScope(await reviewModels(useViewerStore.getState().models))) throw new Error('Tour stop belongs to another model revision.');
          options.applyViewpoint(saved.viewpoint, false);
          if (!await captureViewportFrame(renderer, { read: () => true })) throw new Error('Tour stop could not be presented.');
        });
        if (!live.current.active) throw new DOMException('Tour panel closed during setup.', 'AbortError');
        await tour.start();
        const outcome = tour.getState();
        const current = options.process.current();
        if (current?.status === 'running') {
          if (outcome.outcome !== 'completed') await options.process.interrupt(outcome.status, [row.id]);
          else if (current.inspections.length) await options.process.finish([row.id]);
          else await options.process.interrupt('Fast tour ended without a completed visual analysis.', [row.id]);
        }
        await stream.current.toolResult('fast-tour', { outcome: outcome.outcome, status: outcome.status, completedInspections: options.process.current()?.inspections.length ?? 0, findings: options.process.current()?.findings.length ?? 0 });
        if (outcome.outcome === 'completed') await stream.current.finish();
        else await stream.current.error(outcome.status);
      } catch (error) {
        if (stream.current) { try { await stream.current.error(error); } catch (journalError) { console.error('Fast tour event journal could not finish:', journalError); } }
        if (options.process.current()?.status === 'running') await options.process.interrupt(error instanceof Error ? error.message : String(error), input.current ? [input.current.id] : []);
        throw error;
      } finally { starting.current = false; route.current = null; }
    },
  };
}
