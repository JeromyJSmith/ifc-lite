/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useViewerStore } from '@/store';
import type { SurfaceCommandDefinition } from '@/components/viewer/surface-commands';
import type { EvidenceAdapter } from '@/lib/assistant/adapters/types';
import { createWorkspaceTools, type WorkspaceCallRecord } from './workspace-tools';

test('canonical workspace command changes real tool state and records actual dispatch', async () => {
  const events: WorkspaceCallRecord[] = [];
  const tools = createWorkspaceTools({ record: async event => { events.push(event); return event.phase; } });
  const before = useViewerStore.getState().activeTool;
  try {
    await tools[1].execute({ id: 'tool:measure' });
    assert.equal(useViewerStore.getState().activeTool, 'measure');
    assert.deepEqual(events.map(event => event.phase), ['before', 'after']);
    const catalogue = await tools[0].execute({}) as { commands: { id: string }[]; evidenceSources: { source: string }[] };
    assert.ok(catalogue.commands.some(command => command.id === 'tool:section'));
    assert.ok(catalogue.evidenceSources.some(source => source.source === 'validation'));
    assert.ok(catalogue.evidenceSources.some(source => source.source === 'measurements'));
  } finally { useViewerStore.getState().setActiveTool(before); }
});

test('unavailable native context and host callbacks are explicit, without fake success', async () => {
  const tools = createWorkspaceTools({ record: async () => {} });
  await assert.rejects(tools[1].execute({ id: 'context:delete' }), /mounted active entity/);
  await assert.rejects(tools[1].execute({ id: 'ui:activity' }), /openActivity/);
  await assert.rejects(tools[1].execute({ id: 'file:share' }), /explicit file\/destination/);
  await assert.rejects(tools[1].execute({ id: 'imaginary:button' }), /Unknown native/);
});

test('failed evidence persistence prevents executing the native command', async () => {
  let called = false;
  const command: SurfaceCommandDefinition = { id: 'test:native', labelKey: 'commandPalette.tool.select.label', category: 'Tools',
    keywords: '', icon: (() => null) as SurfaceCommandDefinition['icon'], surfaces: ['palette'], enabled: () => true, run: () => { called = true; } };
  const tools = createWorkspaceTools({ commands: [command], adapters: [], record: async () => { throw new Error('Storage full'); } });
  await assert.rejects(tools[1].execute({ id: command.id }), /Storage full/);
  assert.equal(called, false);
});

test('native adapter evidence retains true availability and total count', async () => {
  const evidence: EvidenceAdapter = { id: 'measurements', group: 'quantities', panelIds: ['measurements'],
    titleKey: 'measure.panel.title', descriptionKey: 'assistantSources.measurements.description', rowMeaningKey: 'assistantSources.measurements.rows',
    unavailableKey: 'assistantSources.measurements.unavailable', suggestionKeys: [], readiness: () => ({ ready: false, status: { labelKey: 'assistantSources.measurements.unavailable' } }), identity: () => null,
    capture: (_state, limit) => ({ summary: { requested: limit }, rows: [], totalRows: 0, availability: 'unavailable' }) };
  const tools = createWorkspaceTools({ adapters: [evidence], record: async () => {} });
  const result = await tools[2].execute({ source: 'measurements', limit: 5 }) as { result: { capture: { availability: string; totalRows: number } } };
  assert.equal(result.result.capture.availability, 'unavailable');
  assert.equal(result.result.capture.totalRows, 0);
});

test('Stop while pre-recording prevents native workspace dispatch', async () => {
  const controller = new AbortController(), events: WorkspaceCallRecord[] = [];
  const before = useViewerStore.getState().activeTool;
  const tools = createWorkspaceTools({ record: async event => {
    events.push(event); if (event.phase === 'before') controller.abort();
  } });
  await assert.rejects(tools[1].execute({ id: 'tool:measure' }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(useViewerStore.getState().activeTool, before);
  assert.deepEqual(events.map(event => event.phase), ['before', 'error']);
});
