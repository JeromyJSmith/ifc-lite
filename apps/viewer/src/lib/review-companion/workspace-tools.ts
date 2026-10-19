/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { SURFACE_COMMANDS, type SurfaceCommandContext, type SurfaceCommandDefinition, type SurfaceCommandState } from '@/components/viewer/surface-commands';
import { runSurfaceCommand } from '@/components/viewer/surface-command-run';
import { ADAPTERS } from '@/lib/assistant/adapters/registry';
import type { EvidenceAdapter } from '@/lib/assistant/adapters/types';
import { resolveEnglish } from '@/i18n/registry';
import { useViewerStore, type ViewerState } from '@/store';
import { createReviewTool, type ReviewTool } from './tools';

export interface WorkspaceCallRecord {
  kind: 'review.workspace.call'; id: string; phase: 'before' | 'after' | 'error';
  operation: 'command' | 'evidence'; target: string; timestamp: string; result?: unknown; error?: string;
}
export interface WorkspaceToolOptions {
  record(event: WorkspaceCallRecord): Promise<unknown>;
  /** Mounted native hosts; absence is reported, never replaced with a stub. */
  context?: Partial<Omit<SurfaceCommandContext, 'surface'>>;
  getState?: () => ViewerState;
  commands?: readonly SurfaceCommandDefinition[];
  adapters?: readonly EvidenceAdapter[];
}
const REQUIRED_HOSTS: Record<string, keyof SurfaceCommandContext> = {
  'file:add-model': 'addModel', 'file:refresh': 'refreshModels', 'file:share': 'openShareDialog',
  'ui:activity': 'openActivity', 'extensions:author': 'activateRightPanel', 'schedule:generate': 'activateBottomPanel',
};
function externalBoundary(id: string): string | undefined {
  if (/^file:|^context:export|^author:import/.test(id)) return 'File/model replacement or external destination needs its explicit file/destination instruction and mounted host.';
  if (/share|publish/.test(id)) return 'External sharing/publication requires explicit destination authorization.';
  return undefined;
}
function commandState(state: ViewerState): SurfaceCommandState {
  return { canEditInSession: state.canCollabEdit(), projectionMode: state.projectionMode, theme: state.theme };
}
function workspaceState(state: ViewerState) {
  return { activeTool: state.activeTool, workspaceMode: state.workspaceMode,
    modelCount: state.models.size, selection: [...state.selectedEntityIds], editEnabled: state.editEnabled,
    measurementCount: state.measurements.length, sectionPlane: state.sectionPlane };
}

/** Adopt the palette/ribbon command registry and native Assistant evidence adapters. */
export function createWorkspaceTools(options: WorkspaceToolOptions): ReviewTool[] {
  const getState = options.getState ?? useViewerStore.getState;
  const commands = options.commands ?? SURFACE_COMMANDS, adapters = options.adapters ?? ADAPTERS;
  const context: Partial<SurfaceCommandContext> = {
    activateRightPanel: panel => getState().showWorkspacePanel(panel, 'palette'),
    activateBottomPanel: panel => getState().toggleBottomPanel(panel, 'palette'),
    ...options.context,
  };
  function unavailable(command: SurfaceCommandDefinition): string | undefined {
    const boundary = externalBoundary(command.id);
    if (boundary) return boundary;
    if (command.id.startsWith('context:') && !context.contextAction) return 'This command requires the mounted active entity menu action; use the exact native SDK element operation instead.';
    const host = REQUIRED_HOSTS[command.id];
    if (host && !context[host]) return `Mounted native host unavailable: ${host}`;
    if (command.id === 'vis:reset-colors' && !context.resetColors && !context.execute) return 'Mounted resetColors host unavailable; use native viewer.resetColors instead.';
    if (!command.enabled(commandState(getState()))) return 'Disabled by the current native command state.';
    return undefined;
  }
  async function recorded(operation: WorkspaceCallRecord['operation'], target: string, run: () => unknown | Promise<unknown>, signal?: AbortSignal) {
    const event: WorkspaceCallRecord = { kind: 'review.workspace.call', id: crypto.randomUUID(), phase: 'before', operation, target, timestamp: new Date().toISOString() };
    const beforeRef = await options.record(event);
    try {
      signal?.throwIfAborted();
      const result = await run();
      const afterRef = await options.record({ ...event, phase: 'after', timestamp: new Date().toISOString(), result });
      return { result, beforeRef, afterRef };
    } catch (error) {
      await options.record({ ...event, phase: 'error', timestamp: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  return [
    createReviewTool('review_workspace_tools', 'List every native palette/ribbon/context command with current availability, and every native Assistant evidence source. Tool activation is distinct from performing a measurement or completing an analysis.', {}, true, () => ({
      counts: { commands: commands.length, evidenceSources: adapters.length },
      commands: commands.map(command => ({ id: command.id, label: resolveEnglish(command.labelKey), category: command.category, keywords: command.keywords,
        surfaces: command.surfaces, unavailableReason: unavailable(command) })),
      evidenceSources: adapters.map(adapter => ({ source: adapter.id, title: resolveEnglish(adapter.titleKey), description: resolveEnglish(adapter.descriptionKey),
        readiness: adapter.readiness(getState()), panels: adapter.panelIds })),
      coverage: 'Commands operate the real viewer. Evidence reads existing native results; it does not run the analysis. SDK clash calls and native analysis panel hosts own their producers.',
    })),
    createReviewTool('review_workspace_command', 'Execute an exact registered native viewer UI command by ID. Discover availability first. Activates real tools/panels and existing modeling commands with their native guards. A measurement tool still needs point picks; opening validation does not run validation. No arbitrary scripts or fabricated button actions.', {
      id: { type: 'string', minLength: 1, maxLength: 200 },
    }, false, (input, execution) => {
      const command = commands.find(item => item.id === input.id);
      if (!command) throw new Error('Unknown native workspace command');
      const reason = unavailable(command);
      if (reason) throw new Error(reason);
      return recorded('command', command.id, () => {
        const surface = command.surfaces.includes('palette') ? 'palette' : command.surfaces[0];
        if (!surface) throw new Error('Native command has no registered surface');
        runSurfaceCommand(command, { ...context, surface });
        return { dispatched: true, state: workspaceState(getState()), limitation: 'Native command dispatched. Any dialog, gesture or asynchronous producer it starts must be checked separately before claiming completion.' };
      }, execution?.signal);
    }),
    createReviewTool('review_workspace_evidence', 'Read a bounded snapshot from an existing native Assistant evidence adapter: validation, clash, BCF, measurements, quantities, changes and other discovered sources. Availability and exact native row totals are retained. An unavailable/empty snapshot is not proof of a successful check.', {
      source: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, true, (input, execution) => {
      const adapter = adapters.find(item => item.id === input.source);
      if (!adapter) throw new Error('Unknown native evidence source');
      return recorded('evidence', adapter.id, () => ({ source: adapter.id, readiness: adapter.readiness(getState()),
        capture: adapter.capture(getState(), input.limit as number) }), execution?.signal);
    }),
  ];
}
