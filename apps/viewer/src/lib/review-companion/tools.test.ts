/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { BonsaiDirectiveError, createReviewTools, registerReviewWebMcp, runBonsaiDirective, type ReviewToolHandlers } from './tools.js';

function handlers(actions: unknown[] = []): ReviewToolHandlers {
  return {
    state: () => ({ mode: 'paused', elements: [{ modelId: 'house', expressId: 42 }] }),
    setDirective: async value => { actions.push(value); return { mode: value.mode }; },
    saveNote: async value => { actions.push(value); return { id: 'note-1', text: value.text }; },
    inspect: async () => ({ findings: [] }),
    listFindings: async () => [{ id: 'note-1', text: 'Measure sill height' }],
    restoreFinding: async value => { actions.push(value); return { restored: value.id }; },
    selectElement: async value => { actions.push(value); return { selected: value }; },
    frameSelection: async () => { actions.push('frame'); return { framed: true }; },
    rotateView: async value => { actions.push(value); return { rotated: value }; },
    zoomView: async value => { actions.push(value); return { zoomed: value }; },
  };
}
test('tools dispatch bounded inputs and reject unknown fields, invalid modes, oversized notes and invalid IFC IDs', async () => {
  const actions: unknown[] = [], tools = createReviewTools(handlers(actions));
  const execute = (name: string, args: unknown) => tools.find(tool => tool.name === name)!.execute(args);
  assert.deepEqual(await execute('viewer_select_element', { modelId: 'house', expressId: 42 }), { selected: { modelId: 'house', expressId: 42 } });
  assert.deepEqual(await execute('review_save_note', { text: 'Measure sill height' }), { id: 'note-1', text: 'Measure sill height' });
  await assert.rejects(execute('review_state', { script: 'delete all' }), /unknown/);
  await assert.rejects(execute('review_set_directive', { mode: 'edit', directive: '' }), /mode/);
  await assert.rejects(execute('review_save_note', { text: 'x'.repeat(8001) }), /text/);
  await assert.rejects(execute('review_save_note', { text: '   ' }), /text/);
  for (const expressId of [-1, 0, NaN, Infinity, 3.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(execute('viewer_select_element', { modelId: 'house', expressId }), /expressId/);
  }
  assert.equal(actions.length, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tools.find(tool => tool.name === 'viewer_frame_selection')!.execute({}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(actions.length, 2);
});

test('WebMCP registers on document modelContext and abort unregisters all tools, including partial failures', async () => {
  const tools = createReviewTools(handlers()), registered: { name: string; signal: AbortSignal }[] = [];
  const registration = await registerReviewWebMcp(tools, { modelContext: {
    async registerTool(tool, { signal }) { registered.push({ name: tool.name, signal }); },
  } });
  assert.equal(registration.available, true);
  assert.deepEqual(registered.map(entry => entry.name), tools.map(tool => tool.name));
  assert.equal(registered.every(entry => !entry.signal.aborted), true);
  registration.cleanup();
  assert.equal(registered.every(entry => entry.signal.aborted), true);
  const unsupported = await registerReviewWebMcp(tools, {});
  assert.equal(unsupported.available, false);
  assert.match(unsupported.reason!, /document.modelContext/);
  let firstSignal: AbortSignal | undefined;
  const failed = await registerReviewWebMcp(tools, { modelContext: {
    registerTool(_tool, { signal }) { if (firstSignal) throw new Error('registration denied'); firstSignal = signal; },
  } });
  assert.equal(failed.available, false);
  assert.match(failed.reason!, /registration denied/);
  assert.equal(firstSignal!.aborted, true);
});

type Payload = Record<string, any>;
async function body(request: IncomingMessage): Promise<Payload> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function withServer(run: (endpoint: string, requests: Payload[]) => Promise<void>, reply: (index: number, payload: Payload) => unknown) {
  const requests: Payload[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/props') response.end(JSON.stringify({ modalities: { vision: true }, model_path: '/models/Bonsai.gguf' }));
    else if (request.url === '/v1/models') response.end(JSON.stringify({ data: [{ id: 'Bonsai' }] }));
    else if (request.url === '/v1/chat/completions') {
      const payload = await body(request); requests.push(payload);
      response.end(JSON.stringify(reply(requests.length - 1, payload)));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`, requests); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const completion = (content: string) => ({ model: 'Bonsai', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
const calls = (...values: { id: string; name: string; args: unknown }[]) => ({ model: 'Bonsai', choices: [{ finish_reason: 'tool_calls', message: {
  role: 'assistant', content: null, tool_calls: values.map(value => ({ id: value.id, type: 'function', function: { name: value.name, arguments: JSON.stringify(value.args) } })),
} }] });

test('local HTTP directive executes the shared tools and returns complete step provenance to caller', async () => {
  const actions: unknown[] = [];
  await withServer(async (endpoint, requests) => {
    const result = await runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Record a sill check.', createReviewTools(handlers(actions)), new AbortController().signal);
    assert.deepEqual(result, { text: 'Saved the note.', steps: [{ tool: 'review_save_note', args: { text: 'Check sill' }, result: { id: 'note-1', text: 'Check sill' } }] });
    assert.deepEqual(actions, [{ text: 'Check sill' }]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tools.length, 10);
    assert.equal(requests[0].parallel_tool_calls, false);
    assert.deepEqual(requests[1].messages.at(-1), { role: 'tool', tool_call_id: 'note-call', content: JSON.stringify({ id: 'note-1', text: 'Check sill' }) });
  }, index => index === 0 ? calls({ id: 'note-call', name: 'review_save_note', args: { text: 'Check sill' } }) : completion('Saved the note.'));
});
test('a failed read is journaled and returned so Bonsai can choose a supported reader', async () => {
  const custom = handlers(); custom.state = () => { throw new Error('STEP reader unavailable for IFCX'); };
  const journal: unknown[] = [];
  await withServer(async (endpoint, requests) => {
    const result = await runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Read the concern.', createReviewTools(custom), new AbortController().signal, { onStep: async step => { journal.push(step); } });
    assert.equal(requests.length, 3); assert.equal(result.steps.length, 2);
    assert.deepEqual(result.steps[0].result, { success: false, error: { tool: 'review_state', message: 'STEP reader unavailable for IFCX' } });
    assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), result.steps[0].result);
    assert.deepEqual(result.steps[1].result, [{ id: 'note-1', text: 'Measure sill height' }]);
    assert.deepEqual(journal, result.steps);
  }, index => index === 0 ? calls({ id: 'unsupported-read', name: 'review_state', args: {} }) : index === 1 ? calls({ id: 'supported-read', name: 'review_findings', args: {} }) : completion('Supported reader returned the concern.'));
});
test('a failed mutation stops instead of being treated as a recoverable read', async () => {
  const custom = handlers(); custom.saveNote = async () => { throw new Error('Durable write failed'); };
  await withServer(async (endpoint, requests) => {
    await assert.rejects(runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Save.', createReviewTools(custom), new AbortController().signal), /Durable write failed/);
    assert.equal(requests.length, 1);
  }, () => calls({ id: 'write-failed', name: 'review_save_note', args: { text: 'Observation' } }));
});
test('cancellation during a failed read stops without another model request', async () => {
  const controller = new AbortController(), custom = handlers();
  custom.state = () => { controller.abort(); throw new Error('Read interrupted'); };
  await withServer(async (endpoint, requests) => {
    await assert.rejects(runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Read.', createReviewTools(custom), controller.signal), /abort/i);
    assert.equal(requests.length, 1);
  }, () => calls({ id: 'cancelled-read', name: 'review_state', args: {} }));
});

test('an unknown or schema-invalid tool in a batch prevents every action in that batch', async () => {
  for (const invalid of [
    { id: 'bad', name: 'eval', args: { code: 'delete()' } },
    { id: 'bad', name: 'viewer_select_element', args: { modelId: 'house', expressId: -42 } },
  ]) {
    const actions: unknown[] = [];
    await withServer(async endpoint => {
      await assert.rejects(runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Inspect.', createReviewTools(handlers(actions)), new AbortController().signal), BonsaiDirectiveError);
      assert.deepEqual(actions, []);
    }, () => calls({ id: 'good', name: 'review_save_note', args: { text: 'Check sill' } }, invalid));
  }
});

test('model identity changes are rejected before a chat request and cancellation sends no requests', async () => {
  await withServer(async (endpoint, requests) => {
    await assert.rejects(runBonsaiDirective({ endpoint, model: 'Bonsai-old' }, 'Inspect.', createReviewTools(handlers()), new AbortController().signal), /model changed/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Inspect.', createReviewTools(handlers()), controller.signal), /aborted/i);
    assert.equal(requests.length, 0);
  }, () => completion('Never called.'));
  await assert.rejects(runBonsaiDirective({ endpoint: 'https://example.com', model: 'Bonsai' }, 'Inspect.', createReviewTools(handlers()), new AbortController().signal), /local Bonsai/);
});

test('cancellation during a completed save retains the action and stops before another model request', async () => {
  const controller = new AbortController(), actions: unknown[] = [];
  const custom = handlers(actions);
  custom.saveNote = async value => { actions.push(value); controller.abort(); return { id: 'saved-before-cancel' }; };
  await withServer(async (endpoint, requests) => {
    await assert.rejects(runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Save note.', createReviewTools(custom), controller.signal), (error: unknown) => {
      assert.ok(error instanceof BonsaiDirectiveError);
      assert.deepEqual(error.steps, [{ tool: 'review_save_note', args: { text: 'Check sill' }, result: { id: 'saved-before-cancel' } }]);
      return true;
    });
    assert.deepEqual(actions, [{ text: 'Check sill' }]);
    assert.equal(requests.length, 1);
  }, () => calls({ id: 'save-cancel', name: 'review_save_note', args: { text: 'Check sill' } }));
});

test('the twelve-call budget retains completed actions and never executes a thirteenth call', async () => {
  const actions: unknown[] = [];
  await withServer(async (endpoint, requests) => {
    await assert.rejects(runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Frame repeatedly.', createReviewTools(handlers(actions)), new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof BonsaiDirectiveError);
      assert.match(error.message, /bounded tool limit/);
      assert.equal(error.steps.length, 12);
      assert.equal(error.steps.every(step => step.tool === 'viewer_frame_selection' && (step.result as { framed: boolean }).framed), true);
      return true;
    });
    assert.equal(actions.length, 12);
    assert.equal(requests.length, 5);
  }, index => calls(...Array.from({ length: 3 }, (_, call) => ({ id: `${index}-${call}`, name: 'viewer_frame_selection', args: {} }))));
});

test('camera controls accept fractional bounded numbers and reject non-finite or out-of-range movement', async () => {
  const actions: unknown[] = [], tools = createReviewTools(handlers(actions));
  const rotate = tools.find(tool => tool.name === 'viewer_rotate')!, zoom = tools.find(tool => tool.name === 'viewer_zoom')!;
  assert.deepEqual(await rotate.execute({ azimuthDegrees: 22.5, elevationDegrees: -12.25 }), { rotated: { azimuthDegrees: 22.5, elevationDegrees: -12.25 } });
  assert.deepEqual(await zoom.execute({ factor: 0.75 }), { zoomed: { factor: 0.75 } });
  for (const azimuthDegrees of [-90.1, 90.1, NaN, Infinity, '30']) await assert.rejects(rotate.execute({ azimuthDegrees, elevationDegrees: 0 }), /azimuthDegrees/);
  for (const elevationDegrees of [-45.1, 45.1, NaN, Infinity]) await assert.rejects(rotate.execute({ azimuthDegrees: 0, elevationDegrees }), /elevationDegrees/);
  for (const factor of [0, 0.49, 2.01, NaN, Infinity, '1']) await assert.rejects(zoom.execute({ factor }), /factor/);
  await assert.rejects(zoom.execute({ factor: 1, script: 'run()' }), /unknown/);
  assert.equal(actions.length, 2);
});

test('the eight-turn budget stops a non-converging one-call-per-turn visual search', async () => {
  const actions: unknown[] = [];
  await withServer(async (endpoint, requests) => {
    await assert.rejects(runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Look around.', createReviewTools(handlers(actions)), new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof BonsaiDirectiveError);
      assert.match(error.message, /bounded tool limit/);
      assert.equal(error.steps.length, 7);
      return true;
    });
    assert.equal(requests.length, 8);
    assert.equal(actions.length, 7);
  }, index => calls({ id: `rotate-${index}`, name: 'viewer_rotate', args: { azimuthDegrees: 30, elevationDegrees: 0 } }));
});

test('multi-view search sends real inspect outputs back to the model between bounded camera moves', async () => {
  const actions: unknown[] = [], custom = handlers(actions);
  const findings = [{ id: 'sill-candidate', text: 'Possible sill intersection; measure before confirming.', elements: [{ modelId: 'house', expressId: 42 }] }];
  custom.inspect = async () => ({ summary: 'Window sill visible.', findings });
  await withServer(async (endpoint, requests) => {
    const result = await runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Rotate, zoom, and inspect the window.', createReviewTools(custom), new AbortController().signal);
    assert.deepEqual(result.steps.map(step => step.tool), ['viewer_rotate', 'viewer_zoom', 'review_inspect']);
    assert.deepEqual(result.steps[2].result, { summary: 'Window sill visible.', findings });
    assert.deepEqual(JSON.parse(requests[3].messages.at(-1).content), { summary: 'Window sill visible.', findings });
    assert.equal(result.text, 'Saved a possible sill issue for checking.');
  }, index => index === 0 ? calls({ id: 'rotate', name: 'viewer_rotate', args: { azimuthDegrees: 45, elevationDegrees: 15 } })
    : index === 1 ? calls({ id: 'zoom', name: 'viewer_zoom', args: { factor: 0.8 } })
    : index === 2 ? calls({ id: 'inspect', name: 'review_inspect', args: {} }) : completion('Saved a possible sill issue for checking.'));
});

test('each completed action is journaled before another request, and a failed journal stops execution', async () => {
  const actions: unknown[] = [], journal: unknown[] = [];
  await withServer(async (endpoint, requests) => {
    await assert.rejects(runBonsaiDirective({ endpoint, model: 'Bonsai' }, 'Frame and preserve the result.', createReviewTools(handlers(actions)), new AbortController().signal, {
      maxTurns: 32, maxCalls: 48,
      onStep: async step => { journal.push(step); throw new Error('Durable journal unavailable'); },
    }), (error: unknown) => {
      assert.ok(error instanceof BonsaiDirectiveError);
      assert.match(error.message, /journal unavailable/);
      assert.equal(error.steps.length, 1); return true;
    });
    assert.equal(requests.length, 1); assert.equal(actions.length, 1);
    assert.deepEqual(journal, [{ tool: 'viewer_frame_selection', args: {}, result: { framed: true } }]);
  }, () => calls({ id: 'journal-frame', name: 'viewer_frame_selection', args: {} }));
});
