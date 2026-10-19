/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { chatCompletionsUsage, type AiTransport } from '@ifc-lite/ai';
import { connectBonsai, localBonsaiEndpoint } from '../review-companion/bonsai.js';
import { LOCAL_BONSAI_ENDPOINT } from './models.js';
import type { StreamMessage } from './stream-client.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local Bonsai response');
  return value as Record<string, unknown>;
}

/**
 * PrismML llama-server /v1/chat/completions, with the existing shared request
 * lifecycle. Endpoint is loopback-only, credentials omitted, and redirects
 * refused. Every call verifies the served Bonsai identity and vision projector
 * before any model evidence leaves the viewer. A failed local call has no
 * hosted fallback. The optional endpoint is useful for an isolated local server.
 */
export function localBonsaiTransport(endpoint = LOCAL_BONSAI_ENDPOINT): AiTransport<StreamMessage> {
  return async call => {
    const local = localBonsaiEndpoint(endpoint);
    const connection = await connectBonsai(local, call.signal);
    for (const message of call.messages) if (Array.isArray(message.content)) {
      for (const part of message.content) if (part.type === 'image_url' &&
        (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url.url) || part.image_url.url.length > 1_200_000)) {
        throw new Error('Local Bonsai accepts bounded raster screenshot data URLs only');
      }
    }
    const schema = call.outputSchema;
    call.onOutputFormat?.(schema ? 'json-schema' : 'text');
    const response = await fetch(`${local}/v1/chat/completions`, {
      method: 'POST', signal: call.signal, redirect: 'error', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: connection.model, stream: false, max_tokens: call.maxOutputTokens,
        chat_template_kwargs: { enable_thinking: false },
        ...(schema ? { response_format: { type: 'json_schema', schema: schema.schema } } : {}),
        messages: [...(call.system ? [{ role: 'system', content: call.system }] : []), ...call.messages],
      }),
    });
    if (!response.ok) throw new Error(`Local Bonsai returned HTTP ${response.status}. No other provider was contacted.`);
    const encoded = await response.text();
    if (encoded.length > 1_000_000) throw new Error('Local Bonsai response exceeded its limit');
    const body = object(JSON.parse(encoded));
    if (body.model !== connection.model) throw new Error('Local Bonsai returned an unexpected model identity');
    const choices = body.choices;
    const choice = Array.isArray(choices) ? object(choices[0]) : object(null);
    const content = object(choice.message).content;
    if (typeof content !== 'string') throw new Error('Local Bonsai returned no text answer');
    const usage = chatCompletionsUsage(body);
    if (usage) call.onTokenUsage(usage);
    if (content) call.onChunk(content);
    call.onFinishReason(typeof choice.finish_reason === 'string' ? choice.finish_reason : null);
    call.onComplete(content);
  };
}
