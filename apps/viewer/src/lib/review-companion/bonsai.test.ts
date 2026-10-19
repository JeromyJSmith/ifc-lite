/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { localBonsaiEndpoint, parseVisualReview } from './bonsai.js';

test('vision observations retain uncertainty and bind only explicitly supplied element indices', () => {
  const raw = '<think>\n\n</think>\n{"summary":"Two windows are visible","findings":[{"text":"The left sill may intersect the wall; inspect the saved view","elementIndices":[1,1]}]}';
  assert.deepEqual(parseVisualReview(raw, 2), { summary: 'Two windows are visible', findings: [{ text: 'The left sill may intersect the wall; inspect the saved view', elementIndices: [1] }] });
  assert.deepEqual(parseVisualReview('{"summary":"No visible issue","findings":[]}', 0).findings, []);
  assert.throws(() => parseVisualReview('{"summary":"Window","findings":[{"text":"wrong","elementIndices":[2]}]}', 2), /unknown element/);
  assert.throws(() => parseVisualReview('{"summary":"Window","findings":[{"text":"wrong","elementIndices":[-1]}]}', 2), /unknown element/);
  assert.throws(() => parseVisualReview('{"summary":"Window","findings":[{"text":"wrong","elementIndices":[0.5]}]}', 2), /unknown element/);
  assert.throws(() => parseVisualReview(JSON.stringify({ summary: 'Many', findings: Array.from({ length: 6 }, () => ({ text: 'possible', elementIndices: [] })) }), 0), /format/);
});

test('Bonsai connection prevents screenshot disclosure to remote, authenticated, redirected or hidden-path endpoints', () => {
  assert.equal(localBonsaiEndpoint('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080');
  assert.equal(localBonsaiEndpoint('http://localhost:8080'), 'http://localhost:8080');
  for (const url of ['https://example.com', 'http://127.0.0.1.evil.example', 'http://user:secret@localhost:8080', 'http://localhost:8080/other', 'http://localhost:8080/?token=x', 'file:///model']) {
    assert.throws(() => localBonsaiEndpoint(url), /local Bonsai/);
  }
});

test('optional visual point is normalized screenshot evidence and never an invented element identity', () => {
  const output = { summary: 'Possible window intersection', findings: [{ text: 'Inspect this surface', elementIndices: [], point: { x: 0.25, y: 0.75 } }] };
  assert.deepEqual(parseVisualReview(JSON.stringify(output), 0).findings[0], output.findings[0]);
  for (const point of [{ x: -0.01, y: 0.5 }, { x: 0.5, y: 1.01 }, { x: '0.5', y: 0.5 }, { x: 0.5 }]) {
    awaitPoint(point);
  }
  function awaitPoint(point: unknown) {
    assert.throws(() => parseVisualReview(JSON.stringify({ ...output, findings: [{ ...output.findings[0], point }] }), 0), /invalid normalized screenshot point/);
  }
});

test('a focused BCF visual response rejects extra findings instead of saving unrelated concerns', () => {
  const raw = JSON.stringify({ summary: 'Corner', findings: [{ text: 'One', elementIndices: [] }, { text: 'Other', elementIndices: [] }] });
  assert.throws(() => parseVisualReview(raw, 0, 1), /format/);
  assert.equal(parseVisualReview(raw, 0).findings.length, 2);
});
