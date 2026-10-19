/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom';
import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { createHotContext } from './hmr-context';
test('a mounted old provider still supplies a consumer from the replacement module', async () => {
  const hotData = {};
  const oldContext = createHotContext<string | null>(null, hotData);
  const replacementContext = createHotContext<string | null>(null, hotData);
  function ReplacementConsumer() { return createElement('span', null, useContext(replacementContext) ?? 'provider missing'); }
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(oldContext.Provider, { value: 'saved viewer service' }, createElement(ReplacementConsumer))); });
    assert.equal(container.textContent, 'saved viewer service');
  } finally { await act(async () => root.unmount()); container.remove(); }
});
test('different module data and production contexts do not share provider state', () => {
  assert.notEqual(createHotContext(null, {}), createHotContext(null, {}));
  assert.notEqual(createHotContext(null), createHotContext(null));
});
