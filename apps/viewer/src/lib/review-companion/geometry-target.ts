/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
/** Resolve an explicit viewer element reference through the native identity table. */
export function resolveGeometryTarget(target: string, globalId: (expressId: number) => string | null | undefined): string {
  if (!target.startsWith('#')) return target;
  if (!/^#[1-9][0-9]*$/.test(target)) throw new Error('Invalid geometry element reference. Use the geometryTarget returned by review_state.');
  const id = Number(target.slice(1));
  if (!Number.isSafeInteger(id)) throw new Error('Invalid geometry element reference.');
  const path = globalId(id);
  if (!path) throw new Error('Geometry element is absent from the loaded model identity table.');
  return path;
}
