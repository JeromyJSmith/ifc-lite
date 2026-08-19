/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `usePagedList` supersession and guard coverage.
 *
 * The hook's own doc comment makes a checkable contract: "never a silent
 * truncation... Aborts in-flight fetches when restarted, reset, or
 * unmounted." It implements that with a `requestIdRef` supersession counter
 * plus an `AbortController`, the exact shape of the stale-response race this
 * codebase has repeatedly gotten wrong elsewhere (`useIfcCache.staleness`,
 * `useClash.stale-run-teardown`, `useCompare.supersession`,
 * `useIfcFederation.resetState`). This file is the first test for this
 * instance of the pattern.
 *
 * `fetchPage` is driven by hand: every call returns a promise this file
 * resolves or rejects itself, so the interleaving between two overlapping
 * requests is CHOSEN, not raced for.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Page } from '@ifc-lite/plugin-api';
import { usePagedList, type PagedListState } from './usePagedList.js';

// ─── Manually-resolved fetch control ──────────────────────────────────────

interface PendingFetch {
  readonly cursor: string | undefined;
  readonly signal: AbortSignal;
  resolve: (page: Page<string>) => void;
  reject: (err: unknown) => void;
}

let pendingFetches: PendingFetch[] = [];

/** A `fetchPage` whose promises are resolved/rejected by hand from the test. */
function controlledFetch(cursor: string | undefined, signal: AbortSignal): Promise<Page<string>> {
  return new Promise<Page<string>>((resolve, reject) => {
    pendingFetches.push({ cursor, signal, resolve, reject });
  });
}

/** Resolve the fetch at `index` (default: the oldest still-pending one). */
function resolveFetch(page: Page<string>, index = 0): void {
  const entry = pendingFetches[index];
  assert.ok(entry, `expected a pending fetch at index ${index}`);
  pendingFetches.splice(index, 1);
  entry.resolve(page);
}

/** Reject the fetch at `index` (default: the oldest still-pending one). */
function rejectFetch(err: unknown, index = 0): void {
  const entry = pendingFetches[index];
  assert.ok(entry, `expected a pending fetch at index ${index}`);
  pendingFetches.splice(index, 1);
  entry.reject(err);
}

const errors: string[] = [];
function onError(message: string): void {
  errors.push(message);
}

// ─── Harness ───────────────────────────────────────────────────────────────

let hook: PagedListState<string> | null = null;
let root: Root | null = null;

function Probe(): null {
  hook = usePagedList<string>(controlledFetch, onError);
  return null;
}

async function mount(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(hook, 'the hook must have rendered');
}

async function flush(): Promise<void> {
  // Let queued microtasks (the async IIFE inside runFetch) settle and the
  // resulting state updates flush through React.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  hook = null;
  pendingFetches = [];
  errors.length = 0;
  await mount();
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  pendingFetches = [];
});

describe('usePagedList', () => {
  it('start() fetches the first page and populates items/cursor/hasMore', async () => {
    act(() => hook!.start());
    assert.equal(pendingFetches.length, 1);
    assert.equal(pendingFetches[0].cursor, undefined, 'first page has no cursor');
    assert.equal(hook!.loading, true);

    resolveFetch({ items: ['a', 'b'], cursor: 'p2' });
    await flush();

    assert.deepEqual(hook!.items, ['a', 'b']);
    assert.equal(hook!.hasMore, true);
    assert.equal(hook!.loading, false);
  });

  it('loadMore() appends and no-ops when cursor is undefined (the "no more pages" sentinel)', async () => {
    act(() => hook!.start());
    resolveFetch({ items: ['a'], cursor: undefined });
    await flush();

    assert.equal(hook!.hasMore, false, 'a page with no cursor reports no more pages');

    act(() => hook!.loadMore());
    assert.equal(
      pendingFetches.length,
      0,
      'loadMore() must no-op once the cursor sentinel says there are no more pages',
    );
    assert.deepEqual(hook!.items, ['a'], 'no items may be appended by a no-op loadMore');
  });

  it('loadMore() no-ops while a fetch is already in flight (busyRef guard)', async () => {
    act(() => hook!.start());
    resolveFetch({ items: ['a'], cursor: 'p2' });
    await flush();
    assert.equal(hook!.hasMore, true);

    // Start a real loadMore, then hammer it again before it resolves.
    act(() => hook!.loadMore());
    assert.equal(pendingFetches.length, 1, 'the first loadMore must have started a fetch');

    act(() => hook!.loadMore());
    act(() => hook!.loadMore());
    assert.equal(
      pendingFetches.length,
      1,
      'loadMore() called again while busy must not start a second fetch',
    );

    resolveFetch({ items: ['b'], cursor: 'p3' });
    await flush();
    assert.deepEqual(hook!.items, ['a', 'b'], 'exactly one page was appended, not duplicated');
  });

  it('start() called again abandons the in-flight page: a late-arriving stale response never lands (never a silent truncation, never a silent duplication)', async () => {
    act(() => hook!.start());
    const firstFetch = pendingFetches[0];
    assert.equal(pendingFetches.length, 1);

    // Restart before the first page ever resolves - e.g. the source switched.
    act(() => hook!.start());
    assert.equal(pendingFetches.length, 2, 'restarting must issue a fresh fetch');
    assert.equal(firstFetch.signal.aborted, true, 'the abandoned request must be aborted');

    // The stale (first) request now resolves LATE, after the restart.
    resolveFetch({ items: ['stale-a', 'stale-b'], cursor: 'stale-cursor' }, 0);
    await flush();
    assert.deepEqual(
      hook!.items,
      [],
      'a late-arriving response from an abandoned request must not land in state',
    );
    assert.equal(hook!.hasMore, false, 'the stale cursor must not overwrite hasMore either');

    // The current (second) request resolving normally still works.
    resolveFetch({ items: ['fresh'], cursor: undefined });
    await flush();
    assert.deepEqual(hook!.items, ['fresh']);
    assert.equal(hook!.loading, false, "the stale request's finally-block must not have already cleared loading");
  });

  it('reset() aborts the in-flight fetch and a late resolution after reset does not write state', async () => {
    act(() => hook!.start());
    const inFlight = pendingFetches[0];

    act(() => hook!.reset());
    assert.equal(inFlight.signal.aborted, true, 'reset() must abort the in-flight request');
    assert.equal(hook!.items.length, 0);
    assert.equal(hook!.loading, false, 'reset() must clear the loading flag synchronously');

    resolveFetch({ items: ['too-late'], cursor: 'x' }, 0);
    await flush();
    assert.deepEqual(hook!.items, [], 'a response resolving after reset() must not write state');
    assert.equal(hook!.loading, false);
  });

  it('unmount aborts the in-flight fetch and a resolution afterwards throws nothing and writes nothing', async () => {
    act(() => hook!.start());
    const inFlight = pendingFetches[0];

    await act(async () => {
      await root!.unmount();
    });
    root = null;
    assert.equal(inFlight.signal.aborted, true, 'unmount must abort the in-flight request');

    // Resolve after unmount - must not throw (no React "update after unmount"
    // warning path exercised, and no crash from writing to a torn-down hook).
    resolveFetch({ items: ['ghost'], cursor: 'x' }, 0);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // No assertion needed beyond "this did not throw" - reaching here is the
    // proof. Errors thrown inside the awaited IIFE would reject and fail the
    // test via an unhandled rejection.
  });

  it('an AbortError raised by fetchPage is swallowed, not routed to onError', async () => {
    act(() => hook!.start());
    const inFlight = pendingFetches[0];
    act(() => hook!.reset());
    assert.equal(inFlight.signal.aborted, true);

    rejectFetch(new DOMException('aborted', 'AbortError'));
    await flush();
    assert.deepEqual(errors, [], 'an AbortError from an abandoned request must not surface via onError');
  });

  it('a genuine fetch failure on the CURRENT request is reported via onError', async () => {
    act(() => hook!.start());
    assert.equal(pendingFetches.length, 1);
    rejectFetch(new Error('boom'));
    await flush();
    assert.deepEqual(errors, ['boom']);
    assert.equal(hook!.loading, false, 'loading must clear even on failure');
  });

  it('a genuine fetch failure on a SUPERSEDED request is not reported via onError', async () => {
    act(() => hook!.start());
    act(() => hook!.start());
    assert.equal(pendingFetches.length, 2, 'both the stale and the current request must be tracked');

    rejectFetch(new Error('stale boom'), 0);
    await flush();
    assert.deepEqual(
      errors,
      [],
      'a rejection from a request superseded by a restart must not be routed to onError',
    );

    resolveFetch({ items: ['fresh'], cursor: undefined });
    await flush();
    assert.deepEqual(hook!.items, ['fresh']);
  });
});
