/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BimBackend } from '@ifc-lite/sdk';
import type { MethodSchema, NamespaceSchema } from '@ifc-lite/sandbox/schema';
import { createNativeTools, nativeSchemaArguments, type NativeCallRecord } from './native-tools';

test('native backend calls use actual own methods and persist before/result/readback', async () => {
  const events: NativeCallRecord[] = [], calls: unknown[][] = [];
  const backend = { store: { resize: async (...args: unknown[]) => { calls.push(args); return { ok: true, size: 3 }; } } } as unknown as BimBackend;
  const tools = createNativeTools({ backend, schemas: [], record: async event => { events.push(event); return event.phase; }, readback: () => ({ overlayCount: 1 }) });
  const result = await tools[1].execute({ api: 'backend', namespace: 'store', method: 'resize', argsJson: '["model",42,{"Height":3}]' });
  assert.deepEqual(calls, [['model', 42, { Height: 3 }]]);
  assert.deepEqual(events.map(event => event.phase), ['before', 'after']);
  assert.equal(events[0].mutating, true);
  assert.deepEqual((result as { readback: unknown }).readback, { overlayCount: 1 });
  await assert.rejects(tools[1].execute({ api: 'backend', namespace: 'store', method: 'constructor', argsJson: '[]' }), /Unknown installed/);
});

test('schema catalogue invokes installed bridge call and preserves native refusal', async () => {
  const events: NativeCallRecord[] = [];
  const schema: NamespaceSchema = { name: 'store', permission: 'store', doc: 'Store', methods: [{
    name: 'move', doc: 'Move in metres', args: ['number'], paramNames: ['distance'], returns: 'value',
    call: (_sdk, args) => { assert.deepEqual(args, [2]); return { ok: false, reason: 'IFCX unsupported' }; },
  }] };
  const tools = createNativeTools({ backend: {} as BimBackend, schemas: [schema], record: async event => { events.push(event); } });
  const result = await tools[1].execute({ api: 'schema', namespace: 'store', method: 'move', argsJson: '[2]' });
  assert.deepEqual((result as { result: unknown }).result, { ok: false, reason: 'IFCX unsupported' });
  assert.equal(events.length, 2);
  await assert.rejects(tools[1].execute({ api: 'schema', namespace: 'store', method: 'move', argsJson: '["2"]' }), /finite native number/);
  assert.equal(events.at(-1)?.phase, 'error');
});

test('failed durable pre-record prevents any native mutation', async () => {
  let calls = 0;
  const backend = { store: { edit: () => { calls++; } } } as unknown as BimBackend;
  const tools = createNativeTools({ backend, schemas: [], record: async () => { throw new Error('Disk full'); } });
  await assert.rejects(tools[1].execute({ api: 'backend', namespace: 'store', method: 'edit', argsJson: '[]' }), /Disk full/);
  assert.equal(calls, 0);
});

test('external/model replacement methods stay discoverable with reasons and cannot run', async () => {
  let calls = 0;
  const backend = { model: { close: () => { calls++; } } } as unknown as BimBackend;
  const tools = createNativeTools({ backend, schemas: [], record: async () => {} });
  assert.match(JSON.stringify(await tools[0].execute({})), /reason.*separate explicit/);
  await assert.rejects(tools[1].execute({ api: 'backend', namespace: 'model', method: 'close', argsJson: '[]' }), /separate explicit/);
  assert.equal(calls, 0);
});

test('discovery is compact and targeted description retains adopted signatures', async () => {
  const tools = createNativeTools({ backend: {} as BimBackend, record: async () => {} });
  assert.equal(tools.length, 3);
  const catalogue = await tools[0].execute({}) as { counts: { schemaMethods: number }; schema: { namespace: string; methods: string[] }[] };
  assert.ok(catalogue.counts.schemaMethods > 150);
  assert.ok(catalogue.schema.find(item => item.namespace === 'query')?.methods.includes('entity'));
  assert.ok(JSON.stringify(catalogue).length < 64000);
  const description = await tools[2].execute({ namespace: 'query', method: 'entity' }) as { schema: { methods: { parameterNames: string[]; args: string[] }[] }[] };
  assert.equal(description.schema[0].methods.length, 1);
  assert.deepEqual(description.schema[0].methods[0].parameterNames, ['modelId', 'expressId']);
  assert.deepEqual(description.schema[0].methods[0].args, ['string', 'number']);
  await assert.rejects(tools[2].execute({ namespace: 'query', method: 'imaginary' }), /Unknown installed/);
});

test('argument conversion matches optional entity refs and variadic strings', () => {
  const method = { args: ['entityRefs?', '...strings'] } as MethodSchema;
  assert.deepEqual(nativeSchemaArguments(method, [null, 'IfcWall', 'IfcSlab']), [undefined, ['IfcWall', 'IfcSlab']]);
  assert.deepEqual(nativeSchemaArguments({ args: ['entityRefs'] } as MethodSchema, [[{ ref: { modelId: 'A', expressId: 0 } }]]), [[{ modelId: 'A', expressId: 0 }]]);
  assert.throws(() => nativeSchemaArguments(method, [null, 1]), /string arguments/);
});

test('Stop during durable pre-record prevents starting a native write', async () => {
  const controller = new AbortController(), events: NativeCallRecord[] = [];
  let called = false;
  const backend = { store: { edit: () => { called = true; } } } as unknown as BimBackend;
  const tools = createNativeTools({ backend, schemas: [], record: async event => {
    events.push(event); if (event.phase === 'before') controller.abort();
  } });
  await assert.rejects(tools[1].execute({ api: 'backend', namespace: 'store', method: 'edit', argsJson: '[]' }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(called, false);
  assert.deepEqual(events.map(event => event.phase), ['before', 'error']);
});

test('native async bridge receives Stop signal and records cancellation', async () => {
  const controller = new AbortController(), events: NativeCallRecord[] = [];
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const schema: NamespaceSchema = { name: 'clash', permission: 'query', doc: 'Analysis', methods: [{
    name: 'run', doc: 'Run native cancellable analysis', args: [], returns: 'value',
    call: (_sdk, _args, context) => new Promise((_resolve, reject) => {
      assert.equal(context.hostSignal, controller.signal);
      context.hostSignal!.addEventListener('abort', () => reject(context.hostSignal!.reason), { once: true });
      started();
    }),
  }] };
  const tools = createNativeTools({ backend: {} as BimBackend, schemas: [schema], record: async event => { events.push(event); } });
  const pending = tools[1].execute({ api: 'schema', namespace: 'clash', method: 'run', argsJson: '[]' }, { signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(events.map(event => event.phase), ['before', 'error']);
});

test('Stop after a completed native effect preserves its after receipt', async () => {
  const controller = new AbortController(), events: NativeCallRecord[] = [];
  const backend = { store: { edit: () => { controller.abort(); return { ok: true }; } } } as unknown as BimBackend;
  const tools = createNativeTools({ backend, schemas: [], record: async event => { events.push(event); return event.phase; } });
  const result = await tools[1].execute({ api: 'backend', namespace: 'store', method: 'edit', argsJson: '[]' }, { signal: controller.signal });
  assert.deepEqual(events.map(event => event.phase), ['before', 'after']);
  assert.deepEqual((result as { result: unknown }).result, { ok: true });
});
