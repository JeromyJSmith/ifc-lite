/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ToolTurnTransport } from '@ifc-lite/ai';
import { fromChatResponse, toChatMessages } from '@ifc-lite/ids-agent/openai';
import { connectBonsai, localBonsaiEndpoint } from '../review-companion/bonsai.js';
import { LOCAL_BONSAI_ENDPOINT } from './models.js';

/**
 * Typed tool-turn protocol adapter for the verified local Bonsai server.
 * Reuses the adopted Chat Completions message/response conversion. The caller's
 * tool registry validates and executes proposed calls; this adapter executes
 * none. Budget, cancellation and receipts remain with the shared tool core.
 */
export function localBonsaiToolTransport(endpoint = LOCAL_BONSAI_ENDPOINT): ToolTurnTransport {
  return async call => {
    const local = localBonsaiEndpoint(endpoint);
    const connection = await connectBonsai(local, call.signal);
    const response = await fetch(`${local}/v1/chat/completions`, {
      method: 'POST', signal: call.signal, redirect: 'error', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: connection.model, stream: false,
        max_tokens: call.maxOutputTokens, chat_template_kwargs: { enable_thinking: false },
        messages: toChatMessages(call),
        tools: call.tools.map(tool => ({ type: 'function', function: {
          name: tool.name, description: tool.description, parameters: tool.inputSchema,
        } })), tool_choice: 'auto',
      }),
    });
    if (!response.ok) throw new Error(`Local Bonsai returned HTTP ${response.status}. No other provider was contacted.`);
    const encoded = await response.text();
    if (encoded.length > 1_000_000) throw new Error('Local Bonsai tool response exceeded its limit');
    const body: unknown = JSON.parse(encoded);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('model' in body) || body.model !== connection.model) {
      throw new Error('Local Bonsai returned an unexpected tool model identity');
    }
    const turn = fromChatResponse(body as Parameters<typeof fromChatResponse>[0]);
    for (const block of turn.content) if (block.type === 'text') call.onText(block.text);
    return turn;
  };
}
