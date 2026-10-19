/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRootBudget, runModelRequest, runToolTurn, type JsonResponseSchema } from '@ifc-lite/ai';
import { localBonsaiTransport } from './local-bonsai.js';
import { localBonsaiToolTransport } from './local-bonsai-tools.js';
import { LOCAL_BONSAI_MODEL_ID, getModelById } from './models.js';
import { resolveStreamRoute } from './byok-guard.js';
import { modelCapabilities } from './model-capabilities.js';
import type { StreamMessage } from './stream-client.js';

/** In-memory protocol fixture, not a model execution or persisted review receipt. */
async function localServer(options: { vision?: boolean; model?: string; replyModel?: string; pause?: boolean; status?: number; toolArguments?: string } = {}) {
  const model = options.model ?? 'Ternary-Bonsai-2-27B';
  const sent: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    sent.push({ path: req.url ?? '', authorization: req.headers.authorization, body: body ? JSON.parse(body) : {} });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/props') { res.end(JSON.stringify({ modalities: { vision: options.vision ?? true }, model_path: `${model}.gguf`, build_info: 'test-protocol-fixture' })); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: model }] })); return; }
    if (req.url !== '/v1/chat/completions') { res.statusCode = 404; res.end('{}'); return; }
    if (options.pause) return;
    res.statusCode = options.status ?? 200;
    res.end(JSON.stringify({ model: options.replyModel ?? model, choices: [{ message: {
      content: 'Possible overlap; inspect the selected wall.',
      ...(options.toolArguments !== undefined ? { tool_calls: [{ id: 'call-review', type: 'function', function: { name: 'inspect_element', arguments: options.toolArguments } }] } : {}),
    }, finish_reason: options.toolArguments === undefined ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 12 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { endpoint: `http://127.0.0.1:${address.port}`, sent, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
function send(endpoint: string, overrides: { signal?: AbortSignal; timeoutMs?: number; budget?: ReturnType<typeof createRootBudget>; outputSchema?: JsonResponseSchema } = {}) {
  const messages: StreamMessage[] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }, { type: 'text', text: 'What may need inspection?' }] }];
  return runModelRequest({ model: LOCAL_BONSAI_MODEL_ID, route: 'local-bonsai',
    transport: localBonsaiTransport(endpoint), messages, system: 'Treat apparent issues as candidates.',
    prepareInput: () => JSON.stringify({ messages, system: 'Treat apparent issues as candidates.', outputSchema: overrides.outputSchema }),
    maxOutputTokens: 2048, routeCeiling: 2048, budget: createRootBudget({ maxRequests: 4, maxOutputTokens: 8192 }), timeoutMs: 10000, ...overrides });
}

test('local Bonsai is selectable, image capable and routes without API keys or a hosted proxy', () => {
  const keys = { anthropicKey: '', anthropicWorkspaceId: '', openaiKey: '' };
  assert.deepEqual(resolveStreamRoute(LOCAL_BONSAI_MODEL_ID, keys), { kind: 'local-bonsai', model: LOCAL_BONSAI_MODEL_ID });
  assert.equal(getModelById(LOCAL_BONSAI_MODEL_ID)?.supportsImages, true);
  assert.equal(getModelById(LOCAL_BONSAI_MODEL_ID)?.source, 'local-bonsai');
  assert.equal(modelCapabilities(LOCAL_BONSAI_MODEL_ID).contextWindow, null);
  assert.equal(modelCapabilities(LOCAL_BONSAI_MODEL_ID).maxOutputTokens, 2048);
});

test('verified local protocol carries image, messages and shared output budget; usage stays provider reported', async t => {
  const fixture = await localServer(); t.after(fixture.close);
  const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 100 });
  const result = await send(fixture.endpoint, { budget });
  assert.equal(result.kind, 'completed');
  assert.ok(result.kind === 'completed');
  assert.equal(result.text, 'Possible overlap; inspect the selected wall.');
  assert.equal(result.receipt.route, 'local-bonsai');
  assert.equal(result.receipt.usageReported, true);
  if (result.receipt.usageReported) assert.deepEqual([result.receipt.inputTokens, result.receipt.outputTokens], [120, 12]);
  assert.equal(fixture.sent.length, 3);
  const completion = fixture.sent.find(r => r.path === '/v1/chat/completions')!;
  assert.equal(completion.authorization, undefined);
  assert.equal(completion.body.model, 'Ternary-Bonsai-2-27B');
  assert.equal(completion.body.max_tokens, 100);
  assert.equal(completion.body.stream, false);
  const messages = completion.body.messages as StreamMessage[];
  assert.equal(messages[0].role, 'system');
  assert.deepEqual(messages[1].content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }, { type: 'text', text: 'What may need inspection?' }]);
  assert.deepEqual(await send(fixture.endpoint, { budget }), { kind: 'refused', reason: 'budget-exhausted' });
  assert.equal(fixture.sent.length, 3, 'budget refusal makes no further server request');
});

for (const [name, options, message] of [
  ['missing vision', { vision: false }, /no vision projector/],
  ['unrelated served model', { model: 'unrelated-model' }, /not serving an identifiable Bonsai/],
] as const) test(`local provider refuses ${name} before sending model evidence`, async t => {
  const fixture = await localServer(options); t.after(fixture.close);
  const result = await send(fixture.endpoint);
  assert.ok(result.kind === 'error'); assert.match(result.message, message);
  assert.equal(fixture.sent.some(r => r.path === '/v1/chat/completions'), false);
});

test('unexpected reply identity is refused without accepting the answer', async t => {
  const fixture = await localServer({ replyModel: 'unrelated-model' }); t.after(fixture.close);
  const result = await send(fixture.endpoint);
  assert.ok(result.kind === 'error'); assert.match(result.message, /unexpected model identity/);
});

test('local failure is returned once and never falls back to another provider', async t => {
  const fixture = await localServer({ status: 503 }); t.after(fixture.close);
  const result = await send(fixture.endpoint);
  assert.ok(result.kind === 'error'); assert.match(result.message, /HTTP 503/);
  assert.deepEqual(fixture.sent.map(r => r.path).sort(), ['/props', '/v1/chat/completions', '/v1/models'].sort());
});

test('shared deadline cancels a stalled local completion and preserves timeout outcome', async t => {
  const fixture = await localServer({ pause: true }); t.after(fixture.close);
  const result = await send(fixture.endpoint, { timeoutMs: 100 });
  assert.equal(result.kind, 'timeout');
  assert.ok(result.kind === 'timeout'); assert.equal(result.receipt.outcome, 'timeout');
});

test('external endpoints are refused before fetch', async () => {
  const result = await send('https://example.com');
  assert.ok(result.kind === 'error'); assert.match(result.message, /local Bonsai server address/);
});

test('schema contract uses llama-server documented schema field and records actual output format', async t => {
  const fixture = await localServer(); t.after(fixture.close);
  const outputSchema: JsonResponseSchema = { name: 'review', schema: { type: 'object', properties: { summary: { type: 'string' } } } };
  const result = await send(fixture.endpoint, { outputSchema });
  assert.ok(result.kind === 'completed');
  assert.equal(result.receipt.outputFormat, 'json-schema');
  assert.deepEqual(fixture.sent.find(r => r.path === '/v1/chat/completions')?.body.response_format,
    { type: 'json_schema', schema: outputSchema.schema });
});

test('caller cancellation before dispatch leaves local service untouched', async t => {
  const fixture = await localServer(); t.after(fixture.close);
  const controller = new AbortController(); controller.abort();
  const result = await send(fixture.endpoint, { signal: controller.signal });
  assert.equal(result.kind, 'cancelled');
  assert.deepEqual(fixture.sent, []);
});

for (const argumentsText of ['{"expressId":42}', '{malformed']) test(`local tool route preserves ${argumentsText.startsWith('{"') ? 'typed arguments' : 'invalid JSON for registry refusal'}`, async t => {
  const fixture = await localServer({ toolArguments: argumentsText }); t.after(fixture.close);
  const result = await runToolTurn({ model: LOCAL_BONSAI_MODEL_ID, route: 'local-bonsai',
    transport: localBonsaiToolTransport(fixture.endpoint), system: 'Only call supplied tools.',
    messages: [{ role: 'user', content: 'Inspect the selected element.' }],
    tools: [{ name: 'inspect_element', description: 'Read an element', strict: false,
      inputSchema: { type: 'object', properties: { expressId: { type: 'integer' } }, required: ['expressId'] } }],
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 2048, routeCeiling: 2048, timeoutMs: 10000,
  });
  assert.ok(result.kind === 'completed');
  assert.equal(result.turn.stopReason, 'tool_use');
  assert.equal(result.turn.servedModel, 'Ternary-Bonsai-2-27B');
  const tool = result.turn.content.find(block => block.type === 'tool_call');
  assert.ok(tool && tool.type === 'tool_call');
  assert.equal(tool.name, 'inspect_element');
  if (argumentsText.startsWith('{"')) assert.deepEqual(tool.input, { expressId: 42 });
  else assert.equal(tool.rawInput, '{malformed');
  const request = fixture.sent.find(row => row.path === '/v1/chat/completions')!;
  assert.equal(request.authorization, undefined);
  assert.equal(request.body.max_tokens, 100);
  assert.equal(request.body.tool_choice, 'auto');
  assert.deepEqual(request.body.tools, [{ type: 'function', function: { name: 'inspect_element', description: 'Read an element',
    parameters: { type: 'object', properties: { expressId: { type: 'integer' } }, required: ['expressId'] } } }]);
});
