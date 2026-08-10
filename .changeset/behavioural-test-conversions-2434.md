---
"@ifc-lite/geometry": patch
"@ifc-lite/pointcloud": patch
---

Convert two source-text test assertions to behavioural ones (#2434)

No shipped code changes — test-only, published so the release notes record the
guarantee's new shape.

- `@ifc-lite/geometry` `wasm-url-plumbing.test.ts`: the `@ifc-lite/wasm`
  subpath-export check no longer reads the `exports` map as JSON; it asks the
  Node resolver to resolve `@ifc-lite/wasm/ifc-lite_bg.wasm` and asserts it
  lands on the built binary. Skipped when `packages/wasm/pkg/` has not been
  built (CI provides it — built from source or fetched prebuilt — before the
  test job runs).
- `@ifc-lite/pointcloud` `worker-bundle.test.ts`: the inline-worker "no module
  syntax" check no longer inspects the head of the string; it compiles the
  whole decoded bundle as a classic script via `node:vm`, which is exactly how
  a Blob worker will evaluate it. Module syntax anywhere in the string now
  fails the test — the old head check would have passed a bundle whose first
  bytes were a license comment followed by `import` statements (verified by
  mutation: shipping the raw tsc-emitted worker instead of the esbuild bundle
  starts with the license comment and only the new assertion goes red).
