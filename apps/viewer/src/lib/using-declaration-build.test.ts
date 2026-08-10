/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression guard for #2130.
 *
 * `vite-plugin-top-level-await` re-parses every emitted ES chunk with SWC. Its
 * parser config asks for plain `ecmascript` without `explicitResourceManagement`,
 * and `@swc/core`'s `Visitor` base class has no `UsingDeclaration` arm — so a
 * single `using x = ...` anywhere in `apps/viewer` failed the production build
 * long after a clean `tsc --noEmit`, with a diagnostic that crashed the error
 * formatter and showed no line number.
 *
 * Both holes are closed by patches (`patches/vite-plugin-top-level-await@1.6.0.patch`,
 * `patches/@swc__core@1.15.8.patch`). This test drives a real `vite.build()` over
 * a four-line fixture that uses `using`, so the guard is the actual build path
 * rather than an assertion about patch file contents.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build, transformWithEsbuild } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';

/**
 * Whether this Node runtime parses `using` natively (V8 explicit resource
 * management — Node 24+). Probed at runtime rather than by version sniffing;
 * the `new Function` body is evaluated by the engine, not transpiled by tsx.
 */
const nativeUsing = (() => {
  if (typeof Symbol.dispose !== 'symbol') return false;
  try {
    // eslint-disable-next-line no-new-func
    new Function("using x = { [Symbol.dispose]() {} };");
    return true;
  } catch {
    return false;
  }
})();

/** The fixture the viewer cannot express today: a `using` declaration plus a TLA. */
const FIXTURE = `
export const order: string[] = [];

class Handle {
  constructor(private readonly name: string) {
    order.push('open:' + this.name);
  }
  [Symbol.dispose]() {
    order.push('close:' + this.name);
  }
}

export function withHandles(): number {
  using a = new Handle('a');
  using b = new Handle('b');
  order.push('body');
  return 42;
}

// Present so the plugin actually engages: without a top-level await it may skip
// the chunk entirely and the parse that #2130 trips over never happens.
export const tla = await Promise.resolve('tla');
`;

interface BuiltChunk {
  order: string[];
  result: number;
}

/**
 * Builds the fixture at `target`, returning the single emitted chunk.
 *
 * `execute: 'native'` imports the chunk as emitted; `execute: 'lowered'`
 * first lowers it to es2022 with the bundler's own transform so runtimes
 * without native `using` (Node 22 in CI) can still run it — lowering cannot
 * invent disposal semantics the chunk lost, so the behavioural assertion
 * stays meaningful either way.
 */
async function buildFixture(
  target: string,
  execute: 'native' | 'lowered',
): Promise<BuiltChunk> {
  const root = mkdtempSync(join(tmpdir(), 'ifclite-2130-'));
  try {
    writeFileSync(join(root, 'entry.ts'), FIXTURE);
    const outDir = join(root, 'dist');
    mkdirSync(outDir, { recursive: true });
    await build({
      root,
      logLevel: 'silent',
      configFile: false,
      build: {
        target,
        outDir,
        emptyOutDir: true,
        lib: { entry: join(root, 'entry.ts'), formats: ['es'], fileName: 'chunk' },
      },
      plugins: [topLevelAwait()],
    });
    const emitted = readdirSync(outDir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
    assert.equal(emitted.length, 1, `expected exactly one chunk, got ${emitted.join(', ')}`);
    let file = join(outDir, emitted[0]!);
    if (execute === 'lowered') {
      // esbuild rather than oxc: esbuild inlines its `using` helpers, so the
      // lowered chunk stays self-contained and importable from a tmpdir
      // (oxc's helpers arrive as `@oxc-project/runtime` imports or a
      // `babelHelpers` global, neither of which resolves out there). This
      // vite version logs a deprecation pointing at `transformWithOxc` —
      // that pointer is exactly the broken alternative, so don't "fix" the
      // warning by following it.
      const code = readFileSync(file, 'utf8');
      const lowered = await transformWithEsbuild(code, file, { target: 'es2022', loader: 'js' });
      file = join(outDir, 'chunk.lowered.mjs');
      writeFileSync(file, lowered.code);
    }
    const mod = (await import(file)) as {
      withHandles: () => number;
      order: string[];
      tla: string;
    };
    const result = mod.withHandles();
    return { order: mod.order, result };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('using declarations survive the vite-plugin-top-level-await pipeline (#2130)', () => {
  it('preserves disposal semantics at target esnext', async () => {
    // Before the patches this rejected with an SWC parse error
    // ("Using declaration is not enabled"), surfacing in the real viewer build
    // as a miette panic with no line number.
    //
    // #2434: behavioural form of the old `assert.match(code, /\busing\b/)`.
    // esnext keeps `using` un-lowered, so the plugin's SWC round trip has to
    // both parse and re-print it. Instead of grepping the chunk for the
    // keyword, RUN it and assert the handles actually got disposed: a chunk
    // that silently lost the declaration never pushes the close events.
    // On runtimes without native `using` the chunk is lowered to es2022
    // first (see buildFixture) — lowering cannot restore a dropped
    // declaration, so the assertion kills the same regression either way.
    const { order, result } = await buildFixture('esnext', nativeUsing ? 'native' : 'lowered');
    assert.equal(result, 42, 'fixture entry did not run to completion');
    assert.deepEqual(
      order,
      ['open:a', 'open:b', 'body', 'close:b', 'close:a'],
      'the `using` disposal semantics were lost in the SWC round trip',
    );
  });

  it('preserves disposal semantics when the target lowers `using`', async () => {
    // es2022 makes esbuild lower `using` to a try/finally stack, so the emitted
    // chunk is executable here and the ordering contract can be asserted for real.
    const { order, result } = await buildFixture('es2022', 'native');
    assert.equal(result, 42, 'fixture entry did not run to completion');
    assert.deepEqual(order, ['open:a', 'open:b', 'body', 'close:b', 'close:a']);
  });
});
