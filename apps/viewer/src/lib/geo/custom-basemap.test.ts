/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  buildCreditHtml,
  classifyTileProviderError,
  decodeCustomBasemap,
  encodeCustomBasemap,
  probeTileAccess,
  toUrlTemplateProviderOptions,
  validateCustomBasemap,
  type CustomBasemap,
} from './custom-basemap.js';

const VALID = {
  protocol: 'xyz' as const,
  url: 'https://tiles.example.org/aerial/{z}/{x}/{y}.png',
  credit: 'Imagery © Example National Mapping Agency, CC BY 4.0',
  creditUrl: 'https://example.org/licence',
  maximumLevel: 20,
};

function ok(draft: Parameters<typeof validateCustomBasemap>[0]): CustomBasemap {
  const result = validateCustomBasemap(draft);
  assert.ok(result.ok, `expected valid, got: ${result.ok ? '' : result.message}`);
  return result.basemap;
}

function err(draft: Parameters<typeof validateCustomBasemap>[0]) {
  const result = validateCustomBasemap(draft);
  assert.ok(!result.ok, 'expected the draft to be rejected');
  return result;
}

describe('custom basemap — URL template validation', () => {
  it('accepts a well-formed XYZ template', () => {
    const basemap = ok(VALID);
    assert.strictEqual(basemap.protocol, 'xyz');
    assert.strictEqual(basemap.url, VALID.url);
    assert.strictEqual(basemap.maximumLevel, 20);
  });

  it('rejects an empty URL', () => {
    assert.strictEqual(err({ ...VALID, url: '   ' }).field, 'url');
  });

  it('rejects a URL that is not http(s) — a tile request is a browser fetch', () => {
    const result = err({ ...VALID, url: 'ftp://tiles.example.org/{z}/{x}/{y}.png' });
    assert.strictEqual(result.field, 'url');
    assert.match(result.message, /https?/i);
  });

  it('rejects a URL with no {z}/{x}/{y} placeholders — a fixed URL is not a tile template', () => {
    const result = err({ ...VALID, url: 'https://tiles.example.org/aerial.png' });
    assert.strictEqual(result.field, 'url');
    assert.match(result.message, /\{z\}/);
  });

  it('rejects a template missing only {x}', () => {
    assert.strictEqual(err({ ...VALID, url: 'https://t.example.org/{z}/{y}.png' }).field, 'url');
  });

  it('accepts {reverseY} in place of {y} (TMS-ordered servers)', () => {
    const basemap = ok({ ...VALID, url: 'https://t.example.org/{z}/{x}/{reverseY}.png' });
    assert.match(basemap.url, /\{reverseY\}/);
  });

  it('accepts the {s} subdomain placeholder', () => {
    ok({ ...VALID, url: 'https://{s}.tiles.example.org/{z}/{x}/{y}.png' });
  });

  it('rejects an unsupported placeholder rather than passing it to Cesium verbatim', () => {
    const result = err({ ...VALID, url: 'https://t.example.org/{z}/{x}/{y}/{apiKey}.png' });
    assert.strictEqual(result.field, 'url');
    assert.match(result.message, /apiKey/);
  });

  it('rejects credentials embedded in the URL — they would be persisted in cleartext', () => {
    const result = err({ ...VALID, url: 'https://user:secret@t.example.org/{z}/{x}/{y}.png' });
    assert.strictEqual(result.field, 'url');
    assert.doesNotMatch(result.message, /secret/);
  });

  it('rejects a maximumLevel outside the tile-pyramid range', () => {
    assert.strictEqual(err({ ...VALID, maximumLevel: 0 }).field, 'maximumLevel');
    assert.strictEqual(err({ ...VALID, maximumLevel: 40 }).field, 'maximumLevel');
    assert.strictEqual(err({ ...VALID, maximumLevel: 12.5 }).field, 'maximumLevel');
  });

  it('leaves maximumLevel undefined when not supplied', () => {
    const basemap = ok({ ...VALID, maximumLevel: undefined });
    assert.strictEqual(basemap.maximumLevel, undefined);
  });
});

describe('custom basemap — attribution is required', () => {
  it('rejects a blank credit', () => {
    const result = err({ ...VALID, credit: '   ' });
    assert.strictEqual(result.field, 'credit');
    assert.match(result.message, /attribution|credit/i);
  });

  it('rejects a missing credit', () => {
    assert.strictEqual(err({ ...VALID, credit: undefined }).field, 'credit');
  });

  it('accepts a credit with no link', () => {
    const basemap = ok({ ...VALID, creditUrl: undefined });
    assert.strictEqual(basemap.creditUrl, undefined);
  });

  it('rejects a non-http credit link (javascript: would become an on-canvas anchor)', () => {
    const result = err({ ...VALID, creditUrl: 'javascript:alert(1)' });
    assert.strictEqual(result.field, 'creditUrl');
  });

  it('escapes the credit text rather than passing markup through', () => {
    const html = buildCreditHtml({ credit: '<img src=x onerror=alert(1)> & co', creditUrl: undefined });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
    assert.match(html, /&amp; co/);
  });

  it('wraps the escaped credit in a safe anchor when a link is supplied', () => {
    const html = buildCreditHtml({ credit: 'Example NMA', creditUrl: 'https://example.org/licence' });
    assert.match(html, /<a href="https:\/\/example\.org\/licence"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, />Example NMA<\/a>/);
  });

  it('escapes quotes in the credit link so it cannot break out of the href attribute', () => {
    const html = buildCreditHtml({ credit: 'x', creditUrl: 'https://example.org/?a="onmouseover="alert(1)' });
    // The payload stays inside the href value as escaped text; what matters is
    // that no raw quote closes the attribute early and turns the rest into a
    // second attribute on the anchor.
    assert.match(html, /href="https:\/\/example\.org\/\?a=&quot;onmouseover=&quot;alert\(1\)"/);
    assert.strictEqual(html.match(/="/g)?.length, 3); // href, target, rel — no smuggled fourth
  });
});

describe('custom basemap — Cesium provider options', () => {
  it('carries url, credit html and maximumLevel', () => {
    const options = toUrlTemplateProviderOptions(ok(VALID));
    assert.strictEqual(options.url, VALID.url);
    assert.strictEqual(options.maximumLevel, 20);
    assert.match(options.credit, /Example National Mapping Agency/);
  });

  it('omits maximumLevel entirely when unset, rather than sending undefined-as-limit', () => {
    const options = toUrlTemplateProviderOptions(ok({ ...VALID, maximumLevel: undefined }));
    assert.ok(!('maximumLevel' in options));
  });
});

describe('custom basemap — persistence codec', () => {
  it('round-trips through the stored string form', () => {
    const basemap = ok(VALID);
    const decoded = decodeCustomBasemap(encodeCustomBasemap(basemap));
    assert.deepStrictEqual(decoded, basemap);
  });

  it('returns null for absent or malformed storage', () => {
    assert.strictEqual(decodeCustomBasemap(null), null);
    assert.strictEqual(decodeCustomBasemap('not json'), null);
    assert.strictEqual(decodeCustomBasemap('[]'), null);
  });

  it('re-validates on read, so a hand-edited entry cannot inject an unchecked value', () => {
    const poisoned = JSON.stringify({ ...VALID, creditUrl: 'javascript:alert(1)' });
    assert.strictEqual(decodeCustomBasemap(poisoned), null);
  });

  it('rejects a stored entry whose protocol is not one this build understands', () => {
    const future = JSON.stringify({ ...VALID, protocol: 'wmts' });
    assert.strictEqual(decodeCustomBasemap(future), null);
  });
});

describe('custom basemap — browser access (CORS) probe', () => {
  const basemap = ok({ ...VALID, url: 'https://{s}.t.example.org/{z}/{x}/{reverseY}.png' });

  it('does NOT explain an auth rejection as a deeper pyramid', async () => {
    // The defect this pins, measured against the service in issue #2685: a
    // malformed API key answers HTTP 400 *with* `access-control-allow-origin`,
    // so it reaches this branch and not the catch. Attaching one
    // "normal for a service whose tiles start at a deeper zoom" sentence to
    // every non-2xx told that user nothing was wrong — save succeeded, the
    // globe stayed empty, and the only text on screen sent them hunting zoom
    // levels. A confident WRONG diagnosis is worse than silence, because it
    // spends their troubleshooting time in the wrong place.
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const result = await probeTileAccess(basemap, async () => new Response('', { status }));
      assert.strictEqual(result.status, 'rejected', `status ${status} must not read as ok`);
      assert.ok(result.message);
      assert.doesNotMatch(result.message, /normal/i, `status ${status} must not be called normal`);
      assert.doesNotMatch(result.message, /deeper zoom/i);
    }
  });

  it('names the key for 401/403 and the quota for 429', async () => {
    const auth = await probeTileAccess(basemap, async () => new Response('', { status: 401 }));
    assert.match(String(auth.message), /API key/i);
    const quota = await probeTileAccess(basemap, async () => new Response('', { status: 429 }));
    assert.match(String(quota.message), /rate or quota/i);
  });

  it('still calls a 404 normal, because at zoom 0 it usually is', async () => {
    // Anti-vacuity for the test above: without this, rejecting EVERY non-2xx
    // would pass it, and a service whose pyramid starts deeper would be
    // reported as broken when it is fine.
    const result = await probeTileAccess(basemap, async () => new Response('', { status: 404 }));
    assert.strictEqual(result.status, 'ok');
    assert.match(String(result.message), /normal/i);
  });

  it('substitutes a concrete zero tile, including the subdomain placeholder', async () => {
    let seen = '';
    await probeTileAccess(basemap, async (url) => {
      seen = String(url);
      return new Response('', { status: 200 });
    });
    assert.strictEqual(seen, 'https://a.t.example.org/0/0/0.png');
    assert.doesNotMatch(seen, /[{}]/);
  });

  it('requests in cors mode — a no-cors probe succeeds opaquely and proves nothing', async () => {
    let init: RequestInit | undefined;
    await probeTileAccess(basemap, async (_url, requestInit) => {
      init = requestInit;
      return new Response('', { status: 200 });
    });
    assert.strictEqual(init?.mode, 'cors');
  });

  it('reports ok when the tile loads', async () => {
    const result = await probeTileAccess(basemap, async () => new Response('', { status: 200 }));
    assert.strictEqual(result.status, 'ok');
  });

  it('treats ANY readable response as browser-accessible — reaching JS proves CORS headers', async () => {
    const result = await probeTileAccess(basemap, async () => new Response('', { status: 404 }));
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.httpStatus, 404);
    assert.match(result.message ?? '', /404/);
  });

  it('reports a blocked server when fetch rejects, and says so in the user-facing message', async () => {
    const result = await probeTileAccess(basemap, async () => {
      throw new TypeError('Failed to fetch');
    });
    assert.strictEqual(result.status, 'blocked');
    assert.match(result.message ?? '', /does not allow browser access/i);
  });
});

describe('custom basemap — poisoned storage must not throw', () => {
  // decodeCustomBasemap's try wraps only JSON.parse, so a wrong-TYPED field
  // reaches validateCustomBasemap and used to call .trim() on it. That
  // TypeError escapes decode, escapes cesiumSlice's unconditional
  // loadCustomBasemap(), and escapes store construction at module evaluation —
  // so `import '@/store'` throws and the viewer never mounts. index.html's
  // mount-timeout backstop then reloads twice, re-reading the same key, and the
  // page stays blank with no in-app recovery.
  //
  // The app cannot write these values (the only writer persists an
  // already-validated object), so the vector is devtools, an extension, or
  // another same-origin script — which is the threat model this module's own
  // header declares. Availability, not confidentiality.
  const poisoned: [string, string][] = [
    ['url as number', '{"protocol":"xyz","url":123,"credit":"c"}'],
    ['url as object', '{"protocol":"xyz","url":{},"credit":"c"}'],
    ['url as array', '{"protocol":"xyz","url":[],"credit":"c"}'],
    ['url as boolean', '{"protocol":"xyz","url":true,"credit":"c"}'],
    ['credit as number', '{"protocol":"xyz","url":"https://t.example.org/{z}/{x}/{y}.png","credit":123}'],
    ['credit as object', '{"protocol":"xyz","url":"https://t.example.org/{z}/{x}/{y}.png","credit":{}}'],
  ];

  for (const [name, raw] of poisoned) {
    it(`fails closed on ${name} instead of throwing`, () => {
      // assert.doesNotThrow is the load-bearing half: returning null is the
      // documented contract, but THROWING is what white-screens the app.
      assert.doesNotThrow(() => decodeCustomBasemap(raw));
      assert.strictEqual(decodeCustomBasemap(raw), null);
    });
  }

  it('drops a non-string creditUrl rather than discarding the whole basemap', () => {
    // creditUrl is OPTIONAL, so the right failure here is losing the licence
    // LINK, not losing the user's working basemap. url and credit are required,
    // which is why a bad value there does reject the entry.
    //
    // This does not weaken the sanitiser: the dangerous case is
    // `creditUrl: "javascript:alert(1)"`, which IS a string and still goes
    // through URL + scheme validation. A number can never become an anchor.
    const raw = '{"protocol":"xyz","url":"https://t.example.org/{z}/{x}/{y}.png","credit":"c","creditUrl":123}';
    assert.doesNotThrow(() => decodeCustomBasemap(raw));
    const decoded = decodeCustomBasemap(raw);
    assert.ok(decoded, 'a bad optional field should not discard the basemap');
    assert.ok(!decoded.creditUrl, 'the non-string creditUrl must not survive');
  });

  it('still rejects a javascript: creditUrl, which IS a string', () => {
    assert.strictEqual(
      decodeCustomBasemap('{"protocol":"xyz","url":"https://t.example.org/{z}/{x}/{y}.png","credit":"c","creditUrl":"javascript:alert(1)"}'),
      null,
    );
  });

  it('still accepts a well-formed stored entry, so the guards are not blanket rejection', () => {
    // Anti-vacuity: without this, deleting every field would pass the loop above.
    const good = decodeCustomBasemap(
      '{"protocol":"xyz","url":"https://t.example.org/{z}/{x}/{y}.png","credit":"Imagery (c) Example"}',
    );
    assert.ok(good);
    assert.strictEqual(good.url, 'https://t.example.org/{z}/{x}/{y}.png');
  });
});

describe('custom basemap — runtime tile failures', () => {
  it('reads a Cesium RequestErrorEvent with no statusCode as blocked, not as a tile gap', () => {
    // Cesium raises `imageryProvider.errorEvent` with a TileProviderError whose
    // `.error` is a RequestErrorEvent. A CORS rejection never produces a
    // response, so `statusCode` is undefined — the signal that separates
    // "the browser was refused" from "that tile is missing".
    const message = classifyTileProviderError({ error: { statusCode: undefined } });
    assert.ok(message);
    assert.match(message, /does not allow browser access/i);
  });

  it('stays silent for a 404, which is ordinary at the edge of a pyramid', () => {
    assert.strictEqual(classifyTileProviderError({ error: { statusCode: 404 } }), null);
  });

  it('names the key for an auth rejection instead of staying silent', () => {
    // The reason this is not silence: the save-time probe is otherwise the ONLY
    // place a wrong key is ever mentioned, so a key that expires AFTER saving
    // would leave the user with an empty globe and nothing on screen at all.
    for (const statusCode of [401, 403]) {
      const message = classifyTileProviderError({ error: { statusCode } });
      assert.ok(message, `expected a message for ${statusCode}`);
      assert.match(message, /API key/i);
      // Still must NOT claim a CORS refusal — the browser plainly got through.
      assert.doesNotMatch(message, /does not allow browser access/i);
    }
  });

  it('distinguishes rate limiting from a server fault, and neither from CORS', () => {
    const rateLimited = classifyTileProviderError({ error: { statusCode: 429 } });
    assert.ok(rateLimited);
    assert.match(rateLimited, /rate-limit/i);

    const serverFault = classifyTileProviderError({ error: { statusCode: 503 } });
    assert.ok(serverFault);
    assert.match(serverFault, /failed/i);

    for (const message of [rateLimited, serverFault]) {
      assert.doesNotMatch(message, /does not allow browser access/i);
    }
  });

  it('ignores a non-numeric statusCode rather than comparing it', () => {
    // `statusCode` arrives as `unknown`; a string would otherwise fall through
    // the `>= 500` comparison and produce a nonsense verdict.
    assert.strictEqual(classifyTileProviderError({ error: { statusCode: '500' } }), null);
  });

  it('ignores an error shape it cannot classify rather than guessing', () => {
    assert.strictEqual(classifyTileProviderError({}), null);
    assert.strictEqual(classifyTileProviderError({ error: new Error('boom') }), null);
  });
});
