/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useBCF, getGlobalRenderer } from './useBCF';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';
import { toGlobalIdFromModels } from '@/store/globalId';
import { connectBonsai, inspectBonsaiView, parseVisualReview, type BonsaiConnection } from '@/lib/review-companion/bonsai';
import { exportResolutionBlob, importResolutionBundle } from '@/lib/review-companion/resolution-archive';
import { reviewModels, reviewScope, rebindReviewModels, candidateContext } from '@/lib/review-companion/context';
import { saveFinding, listFindings, saveEvent, listEvents, listReviewScopes, exportReviewArchive, importReviewArchive } from '@/lib/review-companion/storage';
import { startLocalDictation } from '@/lib/review-companion/speech';
import { createConcernVisionTool } from '@/lib/review-companion/concern-vision-tool';
import { createSurfaceOrbitTool } from '@/lib/review-companion/surface-orbit';
import { createReviewTool, createReviewTools, registerReviewWebMcp, runBonsaiDirective, BonsaiDirectiveError } from '@/lib/review-companion/tools';
import { directiveEvidence } from '@/lib/review-companion/directive-evidence';
import { createReviewBcfBridge, createBcfReviewTools } from '@/lib/review-companion/bcf';
import { createPickedFinding } from '@/lib/review-companion/picking';
import { captureViewportFrame } from '@/lib/viewport-capture';
import { persistReviewJson } from '@/lib/review-companion/journal';
import { createReviewEventStream, type ReviewAgUiEvent } from '@/lib/review-companion/ag-ui';
import { useReviewProcessJournal } from './useReviewProcessJournal';
import { createReviewPropertyProcessEvents } from '@/lib/review-companion/property-process';
import { useReviewFastMode } from './useReviewFastMode';
import { rebindReviewRevision } from '@/lib/review-companion/revision-lineage';
import { prepareSavedIssue } from '@/lib/review-companion/issue-preparation';
import { useReviewResolution, allReviewRows } from './useReviewResolution';
import { useReviewPropertyTools } from './useReviewPropertyTools';
import type { ReviewContext, ReviewFinding, ReviewEvent } from '@/lib/review-companion/types';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const now = () => new Date().toISOString();

export function useReviewCompanion(active: boolean) {
  const models = useViewerStore(s => s.models);
  const { createViewpointFromState, applyViewpoint } = useBCF();
  const [scope, setScope] = useState('');
  const [historyScope, setHistoryScope] = useState('');
  const [scopes, setScopes] = useState<Awaited<ReturnType<typeof listReviewScopes>>>([]);
  const [findings, setFindings] = useState<ReviewFinding[]>([]);
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [pending, setPending] = useState<ReviewFinding[]>([]);
  const [connection, setConnection] = useState<BonsaiConnection | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Ready to take notes');
  const [busy, setBusy] = useState(false);
  const [directing, setDirecting] = useState(false);
  const [mode, setMode] = useState<'paused' | 'observe'>('paused');
  const [directive, setDirective] = useState('Inspect visible building geometry for possible errors.');
  const [listening, setListening] = useState(false);
  const [activity, setActivity] = useState<ReviewAgUiEvent[]>([]);
  const [webMcp, setWebMcp] = useState('WebMCP not checked');
  const stopSpeech = useRef<(() => void) | null>(null);
  const speechContext = useRef<Promise<ReviewContext | null> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const directiveController = useRef<AbortController | null>(null);
  const preparationController = useRef<AbortController | null>(null);
  const running = useRef(false);
  const lastView = useRef('');
  const mounted = useRef(true);
  const activeNow = useRef(active); activeNow.current = active;
  const speechStarting = useRef(false);
  const selectedScope = historyScope || scope;
  const refresh = useCallback(async () => {
    const [all, rows, changes] = await Promise.all([listReviewScopes(), selectedScope ? listFindings(selectedScope) : [], selectedScope ? listEvents(selectedScope) : []]);
    if (mounted.current) { setScopes(all); setFindings(rows); setEvents(changes); }
  }, [selectedScope]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopSpeech.current?.(); controller.current?.abort(); directiveController.current?.abort(); }; }, []);
  useEffect(() => {
    let cancelled = false;
    setScope(''); setHistoryScope('');
    void reviewModels(models).then(reviewScope).then(id => { if (!cancelled) setScope(id); }).catch(e => { if (!cancelled) setError(message(e)); });
    return () => { cancelled = true; };
  }, [models]);
  useEffect(() => { void refresh().catch(e => setError(message(e))); }, [refresh]);
  useEffect(() => {
    if (!active) { setMode('paused'); stopSpeech.current?.(); stopSpeech.current = null; setListening(false); controller.current?.abort(); directiveController.current?.abort(); }
  }, [active]);

  const capture = useCallback(async (): Promise<ReviewContext> => {
    const state = useViewerStore.getState();
    const ids = new Set(state.selectedEntityIds);
    if (state.selectedEntityId !== null) ids.add(state.selectedEntityId);
    const elements = [...ids].map(id => resolveEntityRef(id)).map(ref => ({
      modelId: ref.modelId, expressId: ref.expressId, ifcGlobalId: resolveEntityRefGlobalIdFromState(state, ref),
    }));
    const capturedAt = now();
    const stillValid = () => useViewerStore.getState().models === state.models && useViewerStore.getState().mutationVersion === state.mutationVersion;
    const viewpoint = await createViewpointFromState({ includeSnapshot: true, includeSelection: true, includeHidden: true, isCaptureStillValid: stillValid });
    if (!viewpoint?.snapshot || !stillValid()) throw new Error('The view changed while capturing. Please try again.');
    const sources = await reviewModels(state.models);
    if (!stillValid()) throw new Error('Loaded models changed while capturing. Please try again.');
    return { scopeId: await reviewScope(sources), models: sources, elements, viewpoint, capturedAt, mutationVersion: state.mutationVersion };
  }, [createViewpointFromState]);

  const persist = useCallback(async (finding: ReviewFinding) => {
    try { await saveFinding(finding); setPending(rows => rows.filter(r => r.id !== finding.id)); await refresh(); }
    catch (e) { setPending(rows => rows.some(r => r.id === finding.id) ? rows : [...rows, finding]); throw e; }
    return finding.id;
  }, [refresh]);
  const process = useReviewProcessJournal(persist);
  useEffect(() => {
    if (process.current() || !scope || selectedScope !== scope) return;
    const latest = [...findings].reverse().find(row => {
      if (row.provider || !row.text.startsWith('{')) return false;
      return /^\{"kind":"review\.process\.(?:snapshot|manifest)"/.test(row.text);
    });
    if (latest) void process.recover(latest, findings).catch(e => setError(message(e)));
  }, [findings, scope, selectedScope, process.recover]);
  const properties = useReviewPropertyTools(scope, persist, connection ? { model: connection.model, endpoint: connection.endpoint } : undefined, createReviewPropertyProcessEvents(process));
  const note = useCallback(async (text: string, context?: ReviewContext, provider?: ReviewFinding['provider']) => {
    if (!text.trim() || text.length > 8000) throw new Error('Enter a note of up to 8,000 characters.');
    const record: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), context: context ?? await capture(), kind: 'note', text, createdAt: now(), ...(provider ? { provider } : {}) };
    await persist(record); setStatus('Note saved on this device'); return { id: record.id };
  }, [capture, persist]);
  const inspect = useCallback(async (captured?: ReviewContext, parentSignal?: AbortSignal, instruction = directive, maximumFindings = 5) => {
    if (!connection) throw new Error('Connect Bonsai vision first.');
    if (running.current) throw new Error('A review is already in progress.');
    running.current = true; setBusy(true); setError(''); setStatus(captured ? 'Bonsai is analysing a saved tour view…' : 'Bonsai is inspecting this view…');
    const abort = new AbortController(); controller.current = abort;
    try {
      const context = captured ?? await capture();
      if (context.scopeId !== await reviewScope(await reviewModels(useViewerStore.getState().models)) || context.mutationVersion !== useViewerStore.getState().mutationVersion) throw new Error('Model revision changed before analysing this saved view.');
      const input: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), context, kind: 'note', text: `Visual review requested: ${instruction}`, createdAt: now() };
      await persist(input);
      let ownsProcess = process.current()?.status !== 'running';
      if (ownsProcess) await process.begin(context, instruction, input.id);
      const signal = AbortSignal.any([abort.signal, ...(directiveController.current ? [directiveController.current.signal] : []), ...(parentSignal ? [parentSignal] : [])]);
      const response = await inspectBonsaiView(connection, context, instruction, signal, maximumFindings);
      const raw: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), context, kind: 'note', text: response.raw, createdAt: now(), parentId: input.id, provider: { model: response.model, endpoint: connection.endpoint } };
      await persist(raw);
      if (!response.complete) throw new Error('Bonsai review was incomplete. Its input and raw response were saved; no candidates were accepted.');
      const review = parseVisualReview(response.raw, context.elements.length, maximumFindings);
      const candidates = [];
      const remaining = process.current()?.status === 'running' ? 5 - process.current()!.findings.length : 5;
      for (const f of review.findings.slice(0, remaining)) {
        const candidate: ReviewFinding = { ...raw, id: crypto.randomUUID(), context: candidateContext(context, f.elementIndices), kind: 'candidate', text: f.text, parentId: raw.id, ...(f.point ? { location: f.point } : {}) };
        await persist(candidate); candidates.push({ id: candidate.id, text: candidate.text, elements: candidate.context.elements, location: candidate.location });
      }
      if (process.current()?.status === 'running' && process.current()!.scopeId !== context.scopeId) {
        await process.interrupt('Native model source changed after repair; continuing verification in the corrected source scope.', [input.id, raw.id]);
        await process.begin(context, instruction, input.id); ownsProcess = true;
      }
      if (process.current()?.status === 'running') {
        await process.inspection(context, input.id, raw.id, review.summary, response.model, candidates);
        for (const candidate of candidates) {
          const saved = (await listFindings(context.scopeId)).find(f => f.id === candidate.id)!;
          if (saved.context.elements.length === 1 && saved.context.elements[0].ifcGlobalId) await process.bind(candidate.id, saved);
        }
      }
      if (ownsProcess) await process.finish([input.id, raw.id]);
      setStatus(candidates.length ? `${candidates.length} possible issue(s) saved for review` : `Bonsai: ${review.summary}`);
      return { summary: review.summary, candidates: candidates.length, findings: candidates, evidenceRefs: [input.id, raw.id, ...candidates.map(candidate => candidate.id)] };
    } finally { running.current = false; setBusy(false); controller.current = null; }
  }, [capture, connection, directive, persist]);

  const fast = useReviewFastMode({ active, scope, connected: !!connection, pauseObservation: () => setMode('paused'), capture, inspect, persist, applyViewpoint, process });
  const restore = useCallback(async (id: string) => {
    const row = findings.find(f => f.id === id) ?? (await import('./useReviewResolution').then(m => m.allReviewRows())).find(f => f.id === id);
    if (!row) throw new Error('This finding is not in the selected review.');
    const state = useViewerStore.getState();
    const remap = await rebindReviewRevision(row.context.models, state.models);
    if (useViewerStore.getState().models !== state.models) throw new Error('Loaded models changed while restoring.');
    for (const element of row.context.elements) {
      const ref = { modelId: remap.get(element.modelId)!, expressId: element.expressId };
      if (element.ifcGlobalId && resolveEntityRefGlobalIdFromState(state, ref) !== element.ifcGlobalId) throw new Error('The saved element has changed. Its original image is still available.');
    }
    // Restoration must be settled before the following awaited rotate/capture.
    // The BCF animation API returns void, so awaiting this callback cannot wait for its tween.
    applyViewpoint(row.context.viewpoint, false);
    const refs = row.context.elements.map(e => ({ modelId: remap.get(e.modelId)!, expressId: e.expressId }));
    const live = useViewerStore.getState(); live.clearSelection();
    for (const ref of refs) live.addEntityToSelection(ref);
    live.setSelectedEntityIds(refs.map(ref => toGlobalIdFromModels(live.models, ref.modelId, ref.expressId)));
    live.setSelectedEntityId(refs[0] ? toGlobalIdFromModels(live.models, refs[0].modelId, refs[0].expressId) : null);
    return { restored: id };
  }, [applyViewpoint, findings]);

  const pickFinding = async (id: string) => {
    const finding = (await listFindings(scope)).find(f => f.id === id);
    if (!finding) throw new Error('Finding is not in the current model review.');
    if (finding.context.mutationVersion !== useViewerStore.getState().mutationVersion) throw new Error('The model edit revision differs from this image. Inspect a fresh view before picking.');
    const renderer = getGlobalRenderer(); if (!renderer) throw new Error('Viewer is unavailable.');
    const frame = () => {
      const canvas = renderer.getCanvas(), bounds = canvas.getBoundingClientRect(), camera = renderer.getCamera(), state = useViewerStore.getState();
      return { width: bounds.width, height: bounds.height, signature: JSON.stringify([
        camera.getPosition(), camera.getTarget(), camera.getFOV(), camera.getRotation(), state.mutationVersion,
        [...state.models.values()].map(m => [m.id, m.visible]), [...state.hiddenEntities], state.isolatedEntities ? [...state.isolatedEntities] : null,
        state.sectionPlane, state.inactiveSectionPlanes, state.modelPlacement, state.geometryUpdateTick,
      ]) };
    };
    setStatus('Bonsai is selecting the element at the saved image location…');
    const child = await createPickedFinding(finding, {
      restore: async viewpoint => {
        applyViewpoint(viewpoint, false);
        const presented = await captureViewportFrame(renderer, { read: () => true });
        if (!presented) throw new Error('The saved view could not be presented for picking.');
      }, frame,
      pick: (x, y) => captureViewportFrame(renderer, { read: async (_canvas, options) => { const filters = { hiddenIds: options.hiddenIds, isolatedIds: options.isolatedIds }; const hit = await renderer.pick(x, y, filters); const surface = renderer.raycastScene(x, y, filters)?.intersection; return hit ? { ...hit, surfaceHit: surface?.expressId === hit.expressId ? { point: { ...surface.point }, triangleIndex: surface.triangleIndex, coordinateSpace: 'rendered-viewer-world' as const } : undefined } : null; } }),
      currentModels: () => reviewModels(useViewerStore.getState().models),
    }, directiveController.current?.signal);
    await persist(child);
    const originalId = process.originalFindingId(finding.id);
    if (process.current()?.status === 'running' && process.current()!.findings.some(f => f.id === originalId && f.status === 'candidate')) await process.bind(originalId, child);
    const element = child.context.elements[0], state = useViewerStore.getState();
    state.setSelectedEntity(element); state.setSelectedEntityId(toGlobalIdFromModels(state.models, element.modelId, element.expressId));
    setStatus('Image location selected; exact IFC element saved with a linked observation');
    return { id: child.id, parentId: finding.id, element, surfaceHit: child.surfaceHit, note: 'Native hit identifies the visible element at the suggested location; it does not confirm the suspected defect. Surface coordinates are rendered viewer world, not survey coordinates.' };
  };

  const handlers = {
    pickFinding,
    state: () => {
      const state = useViewerStore.getState(); const ids = new Set(state.selectedEntityIds); if (state.selectedEntityId !== null) ids.add(state.selectedEntityId);
      const selected = [...ids].map(id => resolveEntityRef(id)).map(ref => ({ ...ref, ifcGlobalId: resolveEntityRefGlobalIdFromState(state, ref), geometryTarget: `#${ref.expressId}` }));
      const camera = getGlobalRenderer()?.getCamera();
      return { mode, directive, connected: !!connection, model: connection?.model, scope, busy, models: [...models.values()].map(m => ({ id: m.id, name: m.name })), selected,
        camera: camera ? { position: camera.getPosition(), target: camera.getTarget(), rotation: camera.getRotation(), distance: camera.getDistance() } : null };
    },
    setDirective: (value: { mode: 'paused' | 'observe'; directive: string }) => { if (value.mode === 'observe' && !connection) throw new Error('Connect Bonsai vision before observing.'); setMode(value.mode); setDirective(value.directive); return value; },
    saveNote: (value: { text: string }) => note(value.text, undefined, connection ? { model: connection.model, endpoint: connection.endpoint } : { model: 'external-agent', endpoint: location.origin }), inspect,
    listFindings: async () => findings.filter(f => f.kind === 'candidate').map(f => ({ id: f.id, kind: f.kind, text: f.text, elements: f.context.elements, location: f.location, createdAt: f.createdAt })),
    restoreFinding: (value: { id: string }) => restore(value.id),
    selectElement: async (value: { modelId: string; expressId: number }) => {
      const state = useViewerStore.getState(); const model = state.models.get(value.modelId);
      if (!model?.ifcDataStore?.entities.getTypeName(value.expressId)) throw new Error('Element is not in the loaded model.');
      state.setSelectedEntity(value); state.setSelectedEntityId(toGlobalIdFromModels(state.models, value.modelId, value.expressId));
      return value;
    },
    frameSelection: async () => { const fn = useViewerStore.getState().cameraCallbacks.frameSelection; if (!fn) throw new Error('Viewer camera is unavailable.'); fn(); return { framed: true }; },
    rotateView: async (value: { azimuthDegrees: number; elevationDegrees: number }) => {
      const renderer = getGlobalRenderer(); if (!renderer) throw new Error('Viewer camera is unavailable.');
      setStatus('Bonsai is rotating the model…');
      const camera = renderer.getCamera(); const before = camera.getRotation(); const p = { ...camera.getPosition() }, t = { ...camera.getTarget() };
      camera.setRotation(before.azimuth + value.azimuthDegrees, before.elevation + value.elevationDegrees);
      const destination = { ...camera.getPosition() };
      camera.setPosition(p.x, p.y, p.z);
      await camera.animateTo(destination, t, 350); renderer.requestRender();
      setStatus('Bonsai finished rotating the model');
      return { before, after: camera.getRotation(), position: camera.getPosition(), target: camera.getTarget() };
    },
    zoomView: async (value: { factor: number }) => {
      const renderer = getGlobalRenderer(); if (!renderer) throw new Error('Viewer camera is unavailable.');
      setStatus('Bonsai is zooming the model…');
      const camera = renderer.getCamera(); const p = camera.getPosition(), t = camera.getTarget(); const before = camera.getDistance();
      await camera.animateTo({ x: t.x + (p.x - t.x) / value.factor, y: t.y + (p.y - t.y) / value.factor, z: t.z + (p.z - t.z) / value.factor }, t, 350); renderer.requestRender();
      setStatus('Bonsai finished zooming the model');
      return { before, after: camera.getDistance(), position: camera.getPosition(), target: camera.getTarget() };
    },
  };
  const latest = useRef(handlers); latest.current = handlers;
  const viewerTools = useMemo(() => createReviewTools({
    state: () => latest.current.state(), setDirective: v => latest.current.setDirective(v), saveNote: v => latest.current.saveNote(v), inspect: () => latest.current.inspect(),
    listFindings: () => latest.current.listFindings(), restoreFinding: v => latest.current.restoreFinding(v), selectElement: v => latest.current.selectElement(v), frameSelection: () => latest.current.frameSelection(),
    rotateView: v => latest.current.rotateView(v), zoomView: v => latest.current.zoomView(v),
  }), []);
  const pickTool = useMemo(() => createReviewTool('viewer_pick_finding', 'Restore a saved finding view and visibly select the IFC element at its normalized image location. Returns a new bound finding ID and exact element. Picking does not prove the visual error or authorize a correction.', { findingId: { type: 'string', minLength: 1, maxLength: 200 } }, false, input => latest.current.pickFinding(input.findingId as string)), []);
  const bcf = useMemo(() => createReviewBcfBridge({ scope: () => scope, rows: allReviewRows, persist, canRestore: async row => { await rebindReviewRevision(row.context.models, useViewerStore.getState().models); return true; } }), [scope, persist]);
  const bcfTools = useMemo(() => createBcfReviewTools(bcf), [bcf]);
  const resolution = useReviewResolution({ scope, findings, capture, persist, restore, open: bcf.open, applyViewpoint: context => applyViewpoint(context.viewpoint) });
  const concernVisionTool = useMemo(() => createConcernVisionTool({
    issues: () => resolution.workflow.list(),
    validate: async topicId => {
      const issue = (await resolution.workflow.list()).find(row => row.topicId === topicId);
      if (!issue) throw new Error('Saved issue not found.');
      await rebindReviewRevision(issue.context.models, useViewerStore.getState().models);
    },
    inspect: (question, signal) => inspect(undefined, signal, question, 1),
  }), [resolution.workflow, inspect]);
  const surfaceOrbitTool = useMemo(() => createSurfaceOrbitTool(getGlobalRenderer), []);
  const tools = useMemo(() => [...viewerTools, surfaceOrbitTool, pickTool, concernVisionTool, ...properties.tools, ...bcfTools, ...resolution.tools], [viewerTools, surfaceOrbitTool, pickTool, concernVisionTool, properties.tools, bcfTools, resolution.tools]);
  const reviewHere = async (observation: string) => {
    if (!connection || running.current || directiveController.current || fast.running) throw new Error('Connect Bonsai and wait for the current action to finish.');
    const abort = new AbortController(); directiveController.current = abort; setDirecting(true); setMode('paused'); setError('');
    try {
      setStatus('Capturing your selected surroundings and view…');
      const context = await capture();
      const input = await note(`Describe and log BCF issue: ${observation}`, context);
      if (process.current()?.status === 'running') await process.interrupt('Owner started a new selected-region issue review.');
      await process.begin(context, observation, input.id);
      const result = await inspect(context, abort.signal, `${observation}\nDescribe ONE possible issue in this framed region. The selected elements are surrounding context, not a claim they are faulty. A hole or missing piece has no selectable element. Explain visible evidence, what might be wrong, and what a human should check. Do not invent dimensions or force a defect. Return at most one finding.`);
      abort.signal.throwIfAborted();
      if (!result.findings.length) { await process.finish([input.id]); setStatus(`Observation saved; Bonsai found no specific issue to log. ${result.summary}`); return null; }
      setStatus('Saving BCF issue with your surrounding selection…');
      const candidate = (await listFindings(context.scopeId)).find(row => row.id === result.findings[0].id)!;
      const contextual = { ...candidate, id: crypto.randomUUID(), parentId: candidate.id, context };
      await persist(contextual);
      abort.signal.throwIfAborted();
      const issue = await bcf.create({ findingId: contextual.id, title: `Review: ${candidate.text}`.slice(0, 180), description: candidate.text.slice(0, 4000) });
      await process.finish([input.id, issue.definitionRef]);
      setStatus(`BCF issue saved: ${issue.title}. Ready for your next selection.`);
      return issue;
    } catch (error) {
      if (process.current()?.status === 'running') await process.interrupt(message(error));
      throw error;
    } finally { setDirecting(false); directiveController.current = null; }
  };
  useEffect(() => {
    if (!active) return;
    let disposed = false; let cleanup: (() => void) | undefined;
    void registerReviewWebMcp(tools).then(registration => { cleanup = registration.cleanup; if (disposed) cleanup(); else setWebMcp(registration.available ? 'WebMCP controls available' : 'Native WebMCP unavailable; Bonsai uses the same local controls'); }).catch(e => setError(message(e)));
    return () => { disposed = true; cleanup?.(); };
  }, [active, tools]);

  const inspectLatest = useRef(inspect); inspectLatest.current = inspect;
  useEffect(() => {
    if (!active || mode !== 'observe' || !connection) return;
    lastView.current = '';
    const tick = () => {
      if (document.hidden || running.current || directiveController.current || fast.isRunning()) return;
      const renderer = getGlobalRenderer(); if (!renderer) return;
      const camera = renderer.getCamera(); const state = useViewerStore.getState();
      const key = JSON.stringify([camera.getPosition(), camera.getTarget(), camera.getFOV(), scope, directive, [...state.models.values()].map(m => [m.id, m.visible]), state.mutationVersion, [...state.selectedEntityIds], state.selectedEntityId, [...state.selectedStoreys], state.typeVisibility, state.sectionPlane, state.inactiveSectionPlanes, [...state.hiddenEntities], state.isolatedEntities ? [...state.isolatedEntities] : null]);
      if (key === lastView.current) return;
      lastView.current = key;
      void inspectLatest.current().catch(e => { setError(message(e)); setMode('paused'); });
    };
    tick(); const timer = window.setInterval(tick, 12_000); return () => window.clearInterval(timer);
  }, [active, mode, connection, directive, scope]);

  const dictation = async () => {
    if (stopSpeech.current) { stopSpeech.current(); stopSpeech.current = null; setListening(false); setStatus('Dictation stopped'); return; }
    if (speechStarting.current) return;
    speechStarting.current = true; setListening(true);
    try {
      const stop = await startLocalDictation({
        shouldStart: () => mounted.current && activeNow.current,
        onSpeechStart: () => { speechContext.current = capture().catch(e => { setError(message(e)); return null; }); },
        onText: text => { const pendingContext = speechContext.current; void (async () => {
          const context = await pendingContext;
          if (!context) throw new Error(`Could not attach speech to its view. Copy this unsaved note: ${text}`);
          await note(text, context);
        })().catch(e => setError(message(e))); },
        onState: text => { setStatus(text); if (text === 'Dictation stopped') { setListening(false); stopSpeech.current = null; } },
        onError: e => { setError(message(e)); setListening(false); },
      });
      if (!mounted.current || !activeNow.current) stop(); else stopSpeech.current = stop;
    } catch (e) { setListening(false); throw e; }
    finally { speechStarting.current = false; }
  };
  return { scope, historyScope, setHistoryScope, scopes, findings, events, pending, connection, error, setError, status, setStatus, busy: busy || directing || fast.running, mode, directive, listening, webMcp,
    connect: async () => { const abort = new AbortController(); controller.current = abort; try { const c = await connectBonsai('http://127.0.0.1:8080', abort.signal); setConnection(c); useViewerStore.getState().setChatActiveModel('local-bonsai-2'); setStatus(`Connected to ${c.model}`); } finally { controller.current = null; } },
    note, inspect, inspectConcern: concernVisionTool.execute, restore, dictation, properties, pickFinding, process, activity, fast, bcf, reviewHere, resolution,
    prepareIssue: async (topicId: string) => {
      if (running.current || directiveController.current || preparationController.current) throw new Error('A review is already running.');
      const abort = new AbortController(); preparationController.current = abort; setDirecting(true); setMode('paused');
      try {
        return await prepareSavedIssue({ workflow: resolution.workflow,
          onStatus: setStatus }, topicId, abort.signal);
      } finally { preparationController.current = null; setDirecting(false); }
    },
    setDirective: handlers.setDirective,
    setFindingStatus: async (findingId: string, status: ReviewEvent['status']) => { await saveEvent({ schemaVersion: 1, id: crypto.randomUUID(), findingId, status, createdAt: now() }); await refresh(); },
    retryPending: async () => { for (const row of pending) await persist(row); },
    exportArchive: () => exportResolutionBlob(),
    importArchive: async (value: unknown) => { const result = await importResolutionBundle(value); await refresh(); return result; },
    cancel: () => { preparationController.current?.abort(); fast.stop(); controller.current?.abort(); directiveController.current?.abort(); setMode('paused'); setStatus('Review paused'); },
    ask: async (prompt: string, evidence?: unknown, singleStep = false, issueTopicId?: string) => {
      if (!connection) throw new Error('Connect Bonsai first.');
      if (running.current || directiveController.current || fast.running) throw new Error('A review is already running.');
      const abort = new AbortController(); directiveController.current = abort; setDirecting(true);
      let input: ReviewFinding | undefined;
      let stream: ReturnType<typeof createReviewEventStream> | undefined;
      try {
      const context = await capture();
      input = { schemaVersion: 1, id: crypto.randomUUID(), context, kind: 'note', text: `Directive: ${prompt}`, createdAt: now() };
      await persist(input);
      if (evidence !== undefined) await persistReviewJson({ ...input, id: crypto.randomUUID(), parentId: input.id }, { kind: 'review.directive.evidence', evidence }, persist);
      if (process.current()?.status === 'running') await process.interrupt('A new owner directive superseded this review run.');
      const started = await process.begin(context, prompt, input.id);
      setActivity([]);
      const journalContext = { ...context, viewpoint: { ...context.viewpoint, snapshot: undefined } };
      stream = createReviewEventStream({ threadId: context.scopeId, runId: started.id, onEvent: async event => {
        setActivity(rows => [...rows, event]);
        await persistReviewJson({ ...input!, id: crypto.randomUUID(), context: journalContext, provider: { model: connection.model, endpoint: connection.endpoint }, parentId: input!.id }, { kind: 'ag-ui.event', runId: started.id, event }, persist);
      } });
      await stream.start(); await stream.state({ scopeId: context.scopeId, processId: started.id, stage: 'inspecting' });
        setStatus('Bonsai is choosing its next viewer action…');
        const stepTools = singleStep ? tools.filter(tool => tool.name !== 'review_inspect') : tools;
        const result = await runBonsaiDirective(connection, prompt, stepTools, abort.signal, { evidence: directiveEvidence(context, evidence), singleStep, issueTopicId, maxTurns: singleStep ? 6 : 32, maxCalls: singleStep ? 6 : 48, onToolStart: call => stream!.toolStart(call.id, call.tool, call.args), onStep: async (step, toolCallId) => {
          await stream!.toolResult(toolCallId, step.result);
          await persistReviewJson({ ...input!, id: crypto.randomUUID(), provider: { model: connection.model, endpoint: connection.endpoint }, parentId: input!.id }, { stage: 'tool-completed', step }, persist);
        } });
        await persistReviewJson({ ...input, id: crypto.randomUUID(), provider: { model: connection.model, endpoint: connection.endpoint }, parentId: input.id }, result, persist);
        const text = result.text.trim().replace(/^<think>[\s\S]*?<\/think>\s*/, '');
        if (text) await stream.text(text);
        if (process.current()?.status === 'running' && process.current()!.inspections.length) await process.finish([input.id]);
        else if (process.current()?.status === 'running') await process.interrupt('Directive ended without a visual inspection; no visual validation is claimed.', [input.id]);
        await stream.state({ processId: process.current()!.id, stage: process.current()!.status }); await stream.finish();
        setStatus(text); return result;
      } catch (e) {
        if (stream) { try { await stream.error(e); } catch (deliveryError) { setError(`Activity journal could not finish: ${message(deliveryError)}`); } }
        if (process.current()?.status === 'running') await process.interrupt(message(e), input ? [input.id] : []);
        if (input && e instanceof BonsaiDirectiveError) await persistReviewJson({ ...input, id: crypto.randomUUID(), provider: { model: connection.model, endpoint: connection.endpoint }, parentId: input.id }, { error: e.message, steps: e.steps }, persist);
        throw e;
      } finally { setDirecting(false); directiveController.current = null; }
    },
  };
}
