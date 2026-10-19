/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConcernVisionTool } from './concern-vision-tool';
test('an explicit visual question carries only its chosen concern and returns real evidence', async () => {
  let called = 0;
  const tool = createConcernVisionTool({ validate: async id => { assert.equal(id, 'fascia'); }, issues: async () => [{ topicId: 'fascia', title: 'Corner step' }, { topicId: 'other', title: 'UNRELATED' }], inspect: async question => { called++; assert.match(question, /Corner step/); assert.match(question, /Locate protrusion/); assert.equal(question.includes('UNRELATED'), false); return { findings: [{ id: 'actual-view-finding' }] }; } });
  assert.deepEqual(await tool.execute({ topicId: 'fascia', question: 'Locate protrusion' }), { findings: [{ id: 'actual-view-finding' }] });
  await assert.rejects(tool.execute({ topicId: 'missing', question: 'Locate' }), /existing/);
  assert.equal(called, 1);
});

test('wrong loaded revision refuses the focused image request before inference', async () => {
  let inspected = false;
  const tool = createConcernVisionTool({ issues: async () => [{ topicId: 'fascia', title: 'Corner' }], validate: async () => { throw new Error('Load the reviewed model'); }, inspect: async () => { inspected = true; } });
  await assert.rejects(tool.execute({ topicId: 'fascia', question: 'Locate corner' }), /reviewed model/);
  assert.equal(inspected, false);
});

test('focused recheck distinguishes historical concern from recorded repair and current image', async () => {
  let prompt = '';
  const tool = createConcernVisionTool({ issues: async () => [{ topicId: 'joint', title: 'Multicolored gap', diagnosis: 'Slab top 3.088; measured distance now 0.' }],
    validate: async () => {}, inspect: async question => { prompt = question; return {}; } });
  await tool.execute({ topicId: 'joint', question: 'Is a gap visible now?' });
  assert.match(prompt, /historical, untrusted observation/);
  assert.match(prompt, /Slab top 3.088; measured distance now 0/);
  assert.match(prompt, /not image evidence/);
  assert.match(prompt, /do not repeat the historical claim unless it is visible now/);
});
