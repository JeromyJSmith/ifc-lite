/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { createBimContext, dispatchToBackend, type BimBackend, type BimContext } from '@ifc-lite/sdk';
import { NAMESPACE_SCHEMAS, type NamespaceSchema, type MethodSchema } from '@ifc-lite/sandbox/schema';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { createReviewTool, type ReviewTool } from './tools';

export interface NativeCallRecord {
  kind: 'review.native.call'; id: string; phase: 'before' | 'after' | 'error';
  api: 'schema' | 'backend'; namespace: string; method: string; args: unknown[];
  mutating: boolean; timestamp: string; result?: unknown; error?: string;
}
export interface NativeToolOptions {
  backend?: BimBackend;
  sdk?: BimContext;
  schemas?: readonly NamespaceSchema[];
  /** Awaited before any call and after its actual result. Storage failure is visible. */
  record(event: NativeCallRecord): Promise<unknown>;
  /** Optional native state capture; this is evidence, not a claim of correctness. */
  readback?(): unknown | Promise<unknown>;
}

const READ_NAMESPACES = new Set(['query', 'spatial', 'files', 'schedule', 'structural', 'cost', 'lens']);
/** Public BimBackend namespaces only; LocalBackend's private storeApi is not an SDK API. */
const BACKEND_NAMESPACES = new Set(['model', 'query', 'selection', 'visibility', 'viewer', 'mutate', 'store', 'spatial', 'export', 'lens', 'files', 'schedule', 'structural', 'cost']);
const READ_METHOD = /^(?:get|read|list|find|has|is|can|count|resolve|inspect|query|all|by|active|attributes|properties|quantities|entity|text|csv|presets|matching|validate|check|analyze|calculate|evaluate|detect)/i;
function mutating(namespace: string, method: string): boolean {
  if (namespace === 'model') return !['list', 'active', 'activeId', 'get', 'getActive', 'getAll'].includes(method);
  if (namespace === 'viewer' || namespace === 'selection' || namespace === 'visibility') return false;
  return !(READ_NAMESPACES.has(namespace) && !/^(add|set|remove|delete|assign|create|update|clear|apply)/i.test(method)) && !READ_METHOD.test(method);
}
function unavailable(namespace: string, method: string): string | undefined {
  if (namespace === 'network') return 'Network destinations require explicit destination authorization; the static sandbox catalogue has no network grants.';
  if (namespace === 'model' && /load|open|close|unload|remove|clear/i.test(method)) return 'Replacing or closing loaded models requires a separate explicit destination/model instruction.';
  if (/publish|upload|send|saveAs|writeFile|openFile|fetch|request/i.test(method)) return 'External publication or filesystem/network destination requires explicit destination authorization.';
  return undefined;
}
function ownNamespaces(backend: BimBackend): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [name, value] of Object.entries(backend)) {
    if (!BACKEND_NAMESPACES.has(name)) continue;
    if (!value || typeof value !== 'object') continue;
    const methods = Object.entries(value).filter(([, member]) => typeof member === 'function').map(([method]) => method);
    if (methods.length) result.set(name, methods.sort());
  }
  return result;
}
/** Match the installed bridge's argument conventions without executing arbitrary code. */
export function nativeSchemaArguments(method: MethodSchema, values: unknown[]): unknown[] {
  const restIndex = method.args.indexOf('...strings');
  if (restIndex < 0 && values.length > method.args.length) throw new Error('Too many native arguments');
  const result: unknown[] = [];
  for (let index = 0; index < method.args.length; index++) {
    const type = method.args[index], value = values[index];
    if (type === '...strings') {
      const rest = values.slice(index);
      if (rest.some(item => typeof item !== 'string')) throw new Error('Expected native string arguments');
      result.push(rest); break;
    }
    if (type === 'string' && value !== undefined && typeof value !== 'string') throw new Error('Expected native string argument');
    if (type === 'number' && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Expected finite native number argument');
    if (type.startsWith('entityRefs')) {
      if ((type === 'entityRefs?' && value == null) || (type === 'entityRefsUndefined?' && value === undefined)) { result.push(undefined); continue; }
      const refs = value === undefined && type === 'entityRefs' ? [] : value;
      if (!Array.isArray(refs)) throw new Error('Expected native entity reference array');
      result.push(refs.map(item => {
        const candidate = item && typeof item === 'object' && 'ref' in item ? item.ref : item;
        if (!candidate || typeof candidate !== 'object' || !('modelId' in candidate) || !('expressId' in candidate)
          || typeof candidate.modelId !== 'string' || !Number.isSafeInteger(candidate.expressId) || Number(candidate.expressId) < 0) throw new Error('Invalid native entity reference');
        return candidate;
      }));
    } else result.push(value);
  }
  return result;
}

/** Full adopted SDK catalogue plus callable LocalBackend operations, on the actual viewer. */
export function createNativeTools(options: NativeToolOptions): ReviewTool[] {
  const backend = options.backend ?? new LocalBackend(useViewerStore);
  const sdk = options.sdk ?? createBimContext({ backend });
  const schemas = options.schemas ?? NAMESPACE_SCHEMAS;
  const backendMethods = ownNamespaces(backend);
  const sessionId = `bonsai-native-${crypto.randomUUID()}`;
  const catalogue = () => ({
    counts: { schemaMethods: schemas.reduce((sum, namespace) => sum + namespace.methods.length, 0), backendMethods: [...backendMethods.values()].reduce((sum, methods) => sum + methods.length, 0) },
    coordinateContract: 'Native SDK builders use metres and IFC Z-up unless a method documents otherwise. Never infer repair dimensions from an image alone. Read current model and geometry before editing. Return native refusals unchanged.',
    schema: schemas.map(namespace => ({ namespace: namespace.name, description: namespace.doc, methods: namespace.methods.map(method => ({
      method: method.name, description: method.doc, args: method.args, parameterNames: method.paramNames,
      parameterTypes: method.tsParamTypes, returns: method.tsReturn, semantics: method.llmSemantics,
      mutating: mutating(namespace.name, method.name), unavailableReason: unavailable(namespace.name, method.name),
    })) })),
    backend: [...backendMethods].map(([namespace, methods]) => ({ namespace, methods: methods.map(method => ({
      method, mutating: mutating(namespace, method), unavailableReason: unavailable(namespace, method),
      guidance: 'Direct installed SDK backend method; use schema API when a documented equivalent exists. Native implementation validates its arguments.',
    })) })),
  });
  return [
    createReviewTool('review_native_tools', 'Discover all installed native BIM SDK namespaces and method names, including actual viewer backend methods. Then use review_native_describe for exact parameter types and placement contracts before calling. Use schema API when available.', {}, true, () => {
      const full = catalogue();
      const summary = (namespace: { namespace: string; methods: { method: string; unavailableReason?: string }[] }) => ({ namespace: namespace.namespace,
        count: namespace.methods.length, methods: namespace.methods.map(method => method.method), unavailable: namespace.methods.filter(method => method.unavailableReason).map(method => ({ method: method.method, reason: method.unavailableReason })) });
      return { counts: full.counts, coordinateContract: full.coordinateContract, schema: full.schema.map(summary), backend: full.backend.map(summary),
        coverage: 'These are the installed browser SDK APIs on the current viewer. The separate server MCP catalogue is not a callable API on this viewer. Use review_native_describe for method documentation.' };
    }),
    createReviewTool('review_native_call', 'Call an installed native BIM method in this viewer, with positional JSON array argsJson. Discover names using review_native_tools and exact parameter types using review_native_describe first. api schema uses the adopted validated bridge; backend dispatches an actual own native backend method. All calls are durably recorded before/after. Native edit permissions, undo and supported geometry boundaries remain in force. Do not invent dimensions or report an issue resolved merely because a call succeeded.', {
      api: { type: 'string', enum: ['schema', 'backend'] }, namespace: { type: 'string', minLength: 1, maxLength: 100 },
      method: { type: 'string', minLength: 1, maxLength: 100 }, argsJson: { type: 'string', minLength: 2, maxLength: 128000 },
    }, false, async (input, context) => {
      const api = input.api as 'schema' | 'backend', namespace = input.namespace as string, method = input.method as string;
      const args: unknown = JSON.parse(input.argsJson as string);
      if (!Array.isArray(args)) throw new Error('argsJson must be a JSON array');
      const reason = unavailable(namespace, method);
      if (reason) throw new Error(reason);
      const definition = schemas.find(item => item.name === namespace)?.methods.find(item => item.name === method);
      if (api === 'schema' ? !definition : !backendMethods.get(namespace)?.includes(method)) throw new Error('Unknown installed native method');
      const event: NativeCallRecord = { kind: 'review.native.call', id: crypto.randomUUID(), api, namespace, method, args, mutating: mutating(namespace, method), phase: 'before', timestamp: new Date().toISOString() };
      const beforeRef = await options.record(event);
      try {
        context?.signal?.throwIfAborted();
        const result = await (api === 'schema' && definition
          ? definition.call(sdk, nativeSchemaArguments(definition, args), { sandboxSessionId: sessionId, hostSignal: context?.signal })
          : dispatchToBackend(backend, namespace, method, args));
        const readback = await options.readback?.();
        const afterRef = await options.record({ ...event, phase: 'after', timestamp: new Date().toISOString(), result: { nativeResult: result ?? null, readback } });
        return { result: result ?? null, readback, beforeRef, afterRef, verification: 'Native return and current state captured. This alone does not establish that a building defect is resolved.' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await options.record({ ...event, phase: 'error', timestamp: new Date().toISOString(), error: message });
        throw error;
      }
    }),
    createReviewTool('review_native_describe', 'Read exact installed schema documentation, positional parameters/types, return type and geometry/placement semantics for one namespace and method. Set method to an empty string to describe every method in that namespace. Backend-only methods are identified explicitly; their native implementation validates their inputs.', {
      namespace: { type: 'string', minLength: 1, maxLength: 100 }, method: { type: 'string', maxLength: 100 },
    }, true, input => {
      const full = catalogue(), namespace = input.namespace as string, method = input.method as string;
      const filter = <T extends { namespace: string; methods: { method: string }[] }>(items: T[]) => items.filter(item => item.namespace === namespace).map(item => ({ ...item,
        methods: item.methods.filter(candidate => !method || candidate.method === method) })).filter(item => item.methods.length);
      const schema = filter(full.schema), backend = filter(full.backend);
      if (!schema.length && !backend.length) throw new Error('Unknown installed native namespace or method');
      return { coordinateContract: full.coordinateContract, schema, backend };
    }),
  ];
}
