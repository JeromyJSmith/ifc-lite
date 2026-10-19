/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
// MDN SpeechRecognition processLocally/available/install, read 2026-10-19.
interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface Recognition {
  processLocally?: boolean; lang: string; continuous: boolean; interimResults: boolean;
  onstart: (() => void) | null; onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
}
interface RecognitionConstructor {
  new(): Recognition;
  available?(options: { langs: string[]; processLocally: boolean }): Promise<string>;
  install?(options: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}
export async function startLocalDictation(callbacks: {
  onSpeechStart(): void; onText(text: string): void; onState(text: string): void; onError(error: Error): void;
  shouldStart?(): boolean;
}, host: unknown = globalThis): Promise<() => void> {
  const surface = host as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  const Ctor = surface.SpeechRecognition ?? surface.webkitSpeechRecognition;
  if (!Ctor) throw new Error('This browser has no speech recognition. You can still type notes.');
  const recognition = new Ctor();
  if (!('processLocally' in recognition) || !Ctor.available) throw new Error('On-device dictation is unavailable in this browser. You can still type notes.');
  const options = { langs: ['en-US'], processLocally: true };
  const availability = await Ctor.available(options);
  if (availability !== 'available') {
    if (!['downloadable', 'downloading'].includes(availability) || !Ctor.install) throw new Error('The English on-device speech pack is unavailable.');
    callbacks.onState('Installing the browser’s on-device speech pack…');
    if (!await Ctor.install(options)) throw new Error('The browser could not install its speech pack.');
  }
  recognition.processLocally = true;
  recognition.lang = 'en-US'; recognition.continuous = true; recognition.interimResults = false;
  recognition.onstart = () => callbacks.onState('Listening on this device');
  recognition.onspeechstart = callbacks.onSpeechStart;
  recognition.onresult = event => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal && result[0].transcript.trim()) callbacks.onText(result[0].transcript.trim());
    }
  };
  recognition.onerror = event => callbacks.onError(new Error(`Dictation stopped: ${event.error}. Your saved notes remain available.`));
  recognition.onend = () => callbacks.onState('Dictation stopped');
  if (callbacks.shouldStart?.() !== false) recognition.start();
  return () => { recognition.onresult = null; recognition.onspeechstart = null; recognition.onstart = null; recognition.onend = null; recognition.onerror = null; recognition.abort(); };
}
