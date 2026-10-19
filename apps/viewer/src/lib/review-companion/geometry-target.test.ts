/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGeometryTarget } from './geometry-target';
test('viewer IDs resolve through actual native identities without inventing a prim hierarchy', () => {
  const identities = new Map([[176, 'actual-roof-uuid']]);
  assert.equal(resolveGeometryTarget('#176', id => identities.get(id)), 'actual-roof-uuid');
  assert.equal(resolveGeometryTarget('mesh/body', () => { throw new Error('Unexpected lookup'); }), 'mesh/body');
  assert.throws(() => resolveGeometryTarget('#177', id => identities.get(id)), /absent/);
  for (const target of ['#0', '#-1', '#176/body', '#9007199254740992']) assert.throws(() => resolveGeometryTarget(target, () => 'wrong'), /Invalid/);
});
