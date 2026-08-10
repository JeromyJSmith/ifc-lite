/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Asserts the wasm-URL plumbing surface for #666 follow-up: consumers
 * whose bundler can't transform `new URL('ifc-lite_bg.wasm', import.meta.url)`
 * inside the worker (or who serve the wasm from a different origin) must
 * be able to override it via `ProcessParallelOptions.wasmUrls`.
 *
 * These are surface-level type/shape checks; the integration path is
 * verified via the geometry-processor-streaming tests (which exercise
 * the worker codepath end-to-end against the actual wasm bundle).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { ProcessParallelOptions } from './geometry-parallel.js';
import type { GeometryWorkerInitMessage } from './geometry.worker.js';
import type { GeometryProcessor } from './index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

describe('#666 wasm-url plumbing', () => {
  it('GeometryWorkerInitMessage accepts an optional wasmUrl', () => {
    // The type assertion below is the actual test: if `wasmUrl` is
    // dropped from the message contract, this file fails to typecheck.
    const msg: GeometryWorkerInitMessage = {
      type: 'init',
      wasmUrl: 'https://cdn.example.com/ifc-lite_bg.wasm',
    };
    expect(msg.type).toBe('init');
    expect(msg.wasmUrl).toBe('https://cdn.example.com/ifc-lite_bg.wasm');
  });

  it('ProcessParallelOptions exposes wasmUrls.wasm', () => {
    // If the key is renamed or dropped, the file fails to typecheck.
    const opts: ProcessParallelOptions = {
      wasmUrls: {
        wasm: '/assets/ifc-lite_bg.wasm',
      },
    };
    expect(opts.wasmUrls?.wasm).toBe('/assets/ifc-lite_bg.wasm');
  });

  it('wasmUrls is optional — default Vite/webpack consumers omit it', () => {
    // Critical: passing no wasmUrls must remain valid. Vite/webpack
    // consumers rely on wasm-bindgen's `import.meta.url`-based default
    // resolution; forcing them to provide URLs would break the
    // existing zero-config experience.
    const opts: ProcessParallelOptions = {};
    expect(opts.wasmUrls).toBeUndefined();
  });

  it('GeometryProcessor.processParallel accepts wasmUrls in its public signature', () => {
    // Codex P2 #672: the wasmUrls escape hatch was originally only on
    // the internal `processParallel()` helper, unreachable from the
    // public `GeometryProcessor.processParallel(...)` entry point. This
    // type-level check ensures the public signature accepts it — if
    // someone drops the param, this file fails to typecheck.
    type ProcessParallelMethod = GeometryProcessor['processParallel'];
    type Args = Parameters<ProcessParallelMethod>;
    // 5th positional parameter is wasmUrls (after buffer, sharedRtcOffset,
    // existingSab, onEntityIndex).
    const wasmUrlsArg: Args[4] = { wasm: '/x.wasm' };
    expect(wasmUrlsArg).toBeDefined();
  });

  it('GeometryProcessor.processAdaptive accepts wasmUrls in its options object', () => {
    type ProcessAdaptiveMethod = GeometryProcessor['processAdaptive'];
    type Options = Parameters<ProcessAdaptiveMethod>[1];
    // The options bag must include wasmUrls so the adaptive entry point —
    // which is what consumers actually call from the published package —
    // can thread the escape hatch through to processParallel.
    const opts: Options = { wasmUrls: { wasm: '/x.wasm' } };
    expect(opts.wasmUrls?.wasm).toBe('/x.wasm');
  });
});

describe('#666 wasm package exports the binary at a resolvable subpath', () => {
  // Codex P2 #672: the README documented `@ifc-lite/wasm/ifc-lite_bg.wasm?url`
  // but the package's `exports` map only exposed `.`, so bundlers honoring
  // exports would reject the subpath import. This test fails if anyone
  // re-collapses the exports to just `.` again.
  //
  // #2434: behavioural form — instead of asserting the `exports` map's string
  // value, ask the actual Node resolver to resolve the subpath, exactly as an
  // exports-honoring consumer would. Collapsing the map throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED; remapping it to the wrong file fails the
  // path equality. Skipped when `packages/wasm/pkg/` hasn't been built
  // (gitignored; CI's build job provides it — from source or as a prebuilt
  // fetch — before the test job runs) because the CJS resolver requires the
  // target file to exist.
  const repoRoot = resolve(__dirname, '../../..');
  const builtWasm = resolve(repoRoot, 'packages/wasm/pkg/ifc-lite_bg.wasm');
  const hasWasmBuild = existsSync(builtWasm);

  (hasWasmBuild ? it : it.skip)('the Node resolver maps @ifc-lite/wasm/ifc-lite_bg.wasm to the built binary', () => {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@ifc-lite/wasm/ifc-lite_bg.wasm');
    expect(realpathSync(resolved)).toBe(realpathSync(builtWasm));
  });
});
