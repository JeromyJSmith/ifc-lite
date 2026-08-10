/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Asserts the published shape of `dist/streaming/inline-worker.js`.
 *
 * The whole point of #666's fix is that consumers shouldn't need to
 * configure `worker.format: 'es'` or `optimizeDeps.exclude` in their
 * Vite build. That guarantee depends on three properties of the published
 * dist that are tedious to verify by eye and easy to regress accidentally:
 *
 *  1. `dist/streaming/inline-worker.js` exists and exports an
 *     `INLINE_WORKER_CODE` string. (If the post-`tsc` build step is
 *     skipped, the placeholder from `src` ships with `null` and every
 *     consumer falls back to the new-URL spawn path — same #666 bug.)
 *  2. The string is non-trivial — at least 50 KB. The actual bundle is
 *     ~225 KB; a single-digit-KB result means esbuild only emitted the
 *     decode-worker shell and lost the format sources (regression on the
 *     bundling step's `splitting: false` / `treeShaking: false` config).
 *  3. The bundled string compiles as a CLASSIC script — no top-level
 *     `import`/`export` anywhere — because we feed it verbatim into a
 *     `Blob` worker that can't host module syntax.
 *
 * The test is import-by-file-path so it runs against the published shape
 * even when the package isn't installed via npm. It's skipped when the
 * dist hasn't been built yet (CI builds before testing; local dev can run
 * `pnpm --filter @ifc-lite/pointcloud build` once to enable it).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distInlineWorker = resolve(__dirname, '../../dist/streaming/inline-worker.js');

describe('inline-worker bundle (dist)', () => {
  const hasBuild = existsSync(distInlineWorker);

  (hasBuild ? it : it.skip)('exports a non-trivial INLINE_WORKER_CODE string', () => {
    const text = readFileSync(distInlineWorker, 'utf8');
    expect(text).toContain('export const INLINE_WORKER_CODE');
    // 50 KB lower bound: the bundle should contain the decode-worker
    // shell, protocol, plus all six format sources (LAS/LAZ/PLY/PCD/E57/
    // ASCII). A bundle smaller than this almost certainly missed one or
    // more format sources — esbuild's `splitting: false` setting is what
    // keeps them inlined.
    expect(text.length).toBeGreaterThan(50_000);
  });

  (hasBuild ? it : it.skip)('inlines every format-specific source', () => {
    const text = readFileSync(distInlineWorker, 'utf8');
    for (const name of [
      'LasStreamingSource',
      'LazStreamingSource',
      'PlyStreamingSource',
      'PcdStreamingSource',
      'E57StreamingSource',
      'AsciiPointsStreamingSource',
    ]) {
      expect(text, `${name} missing from inline-worker bundle`).toContain(name);
    }
  });

  (hasBuild ? it : it.skip)('bundle string compiles as a classic script — no module syntax that would break Blob workers', () => {
    const text = readFileSync(distInlineWorker, 'utf8');
    // Extract the actual bundled-worker string (it's JSON-encoded inside
    // the `export const INLINE_WORKER_CODE = "…";` declaration).
    const match = text.match(/export const INLINE_WORKER_CODE = (".*");\s*$/s);
    expect(match, 'failed to locate INLINE_WORKER_CODE declaration').toBeTruthy();
    const decoded = JSON.parse(match![1]) as string;
    // #2434: behavioural form of the old starts-with-`import`/`export` head
    // check. The consumer feeds this string verbatim to `new Worker(Blob)`,
    // which evaluates it as a CLASSIC script under any `worker.format` — so
    // compile it here the same way. Top-level `import`/`export` anywhere in
    // the string (not just the first line) is a SyntaxError in a classic
    // script, which is exactly the failure a Blob worker would hit.
    expect(
      () => new Script(decoded, { filename: 'inline-worker-blob.js' }),
      'bundle contains module syntax (or is otherwise not compilable as a classic script)',
    ).not.toThrow();
  });
});
