/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLocalDictation } from './speech';

interface ResultEvent { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }
type PackOptions = { langs: string[]; processLocally: boolean };
function fixture(options: { availability?: string; install?: boolean; hasLocal?: boolean; startError?: string } = {}) {
  const availabilityCalls: PackOptions[] = [], installCalls: PackOptions[] = [];
  const instances: Recognition[] = [];
  class Recognition {
    declare processLocally?: boolean;
    lang = ''; continuous = false; interimResults = true;
    onstart: (() => void) | null = null; onend: (() => void) | null = null;
    onspeechstart: (() => void) | null = null;
    onresult: ((event: ResultEvent) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    starts = 0; aborts = 0;
    startConfiguration: { local?: boolean; lang: string; continuous: boolean; interim: boolean } | null = null;
    constructor() { if (options.hasLocal !== false) this.processLocally = false; instances.push(this); }
    static async available(pack: PackOptions) { availabilityCalls.push(pack); return options.availability ?? 'available'; }
    static async install(pack: PackOptions) { installCalls.push(pack); return options.install ?? true; }
    start() {
      this.starts++;
      this.startConfiguration = { local: this.processLocally, lang: this.lang, continuous: this.continuous, interim: this.interimResults };
      if (options.startError) throw new Error(options.startError);
      this.onstart?.();
    }
    stop() { this.onend?.(); }
    abort() { this.aborts++; this.onend?.(); }
  }
  const text: string[] = [], states: string[] = [], errors: string[] = [];
  let speechStarts = 0;
  const callbacks = { onText: (value: string) => text.push(value), onState: (value: string) => states.push(value),
    onError: (error: Error) => errors.push(error.message), onSpeechStart: () => { speechStarts++; } };
  return { host: { SpeechRecognition: Recognition }, callbacks, instances, availabilityCalls, installCalls, text, states, errors, speechStarts: () => speechStarts };
}

test('dictation requires explicit on-device support and enables it before recognition starts', async () => {
  const f = fixture();
  const stop = await startLocalDictation(f.callbacks, f.host);
  assert.deepEqual(f.availabilityCalls, [{ langs: ['en-US'], processLocally: true }]);
  assert.deepEqual(f.installCalls, []);
  assert.deepEqual(f.instances[0].startConfiguration, { local: true, lang: 'en-US', continuous: true, interim: false });
  assert.deepEqual(f.states, ['Listening on this device']);
  stop();
});

for (const availability of ['downloadable', 'downloading']) test(`on-device pack ${availability} is installed with local-only options`, async () => {
  const f = fixture({ availability });
  const stop = await startLocalDictation(f.callbacks, f.host);
  assert.deepEqual(f.installCalls, [{ langs: ['en-US'], processLocally: true }]);
  assert.match(f.states[0], /Installing.*on-device speech pack/);
  assert.equal(f.instances[0].starts, 1);
  assert.equal(f.instances[0].startConfiguration?.local, true);
  stop();
});

test('only final nonempty transcripts at or after resultIndex become notes; speech onset is exposed', async () => {
  const f = fixture(); const stop = await startLocalDictation(f.callbacks, f.host);
  const recognition = f.instances[0];
  recognition.onspeechstart?.();
  recognition.onresult?.({ resultIndex: 1, results: [
    { isFinal: true, 0: { transcript: 'previous final must not repeat' } },
    { isFinal: false, 0: { transcript: 'interim hypothesis must not persist' } },
    { isFinal: true, 0: { transcript: '  Window sill appears low.  ' } },
    { isFinal: true, 0: { transcript: '   ' } },
    { isFinal: true, 0: { transcript: 'Measure its height.' } },
  ] });
  assert.deepEqual(f.text, ['Window sill appears low.', 'Measure its height.']);
  assert.equal(f.speechStarts(), 1);
  stop();
});

test('cleanup detaches callbacks before abort and prevents late recognition events from adding notes', async () => {
  const f = fixture(); const stop = await startLocalDictation(f.callbacks, f.host);
  const recognition = f.instances[0]; stop();
  assert.equal(recognition.aborts, 1);
  assert.deepEqual([recognition.onresult, recognition.onspeechstart, recognition.onstart, recognition.onend, recognition.onerror], [null, null, null, null, null]);
  assert.deepEqual(f.states, ['Listening on this device'], 'abort did not emit a stale onend callback');
  assert.deepEqual(f.text, []);
});

test('recognition failures are explicit and do not start a cloud recognizer or retry', async () => {
  const f = fixture(); const stop = await startLocalDictation(f.callbacks, f.host);
  f.instances[0].onerror?.({ error: 'not-allowed' });
  assert.deepEqual(f.errors, ['Dictation stopped: not-allowed. Your saved notes remain available.']);
  assert.equal(f.instances[0].starts, 1);
  assert.equal(f.instances[0].processLocally, true);
  assert.deepEqual(f.text, []);
  f.instances[0].onend?.();
  assert.equal(f.states.at(-1), 'Dictation stopped'); stop();
});

test('unsupported local capability refuses before microphone start even when another recognizer exists', async () => {
  const f = fixture({ hasLocal: false });
  let fallbackStarts = 0;
  class CloudOnly { start() { fallbackStarts++; } }
  await assert.rejects(startLocalDictation(f.callbacks, { ...f.host, webkitSpeechRecognition: CloudOnly }), /On-device dictation is unavailable/);
  assert.equal(f.instances[0].starts, 0);
  assert.equal(fallbackStarts, 0);
  assert.deepEqual(f.availabilityCalls, []);
});

test('missing recognizer and missing availability API fail explicitly', async () => {
  const f = fixture();
  await assert.rejects(startLocalDictation(f.callbacks, {}), /no speech recognition/);
  class WithoutAvailability { processLocally = false; }
  await assert.rejects(startLocalDictation(f.callbacks, { SpeechRecognition: WithoutAvailability }), /On-device dictation is unavailable/);
  assert.deepEqual(f.text, []);
});

for (const options of [{ availability: 'unavailable' }, { availability: 'downloadable', install: false }]) test(`pack ${options.availability}${options.install === false ? ' install failure' : ''} never falls back to cloud speech`, async () => {
  const f = fixture(options);
  await assert.rejects(startLocalDictation(f.callbacks, f.host), /speech pack/);
  assert.equal(f.instances[0].starts, 0);
  assert.deepEqual(f.text, []);
});

test('a microphone start exception reaches the caller without retrying another recognizer', async () => {
  const f = fixture({ startError: 'microphone refused' });
  await assert.rejects(startLocalDictation(f.callbacks, f.host), /microphone refused/);
  assert.equal(f.instances[0].starts, 1);
  assert.equal(f.instances[0].processLocally, true);
});
