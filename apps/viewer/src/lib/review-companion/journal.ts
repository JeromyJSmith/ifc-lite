/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import type { ReviewFinding } from './types';

/** Preserve large real tool outputs without truncation or duplicating their input image. */
export async function persistReviewJson(base: ReviewFinding, value: unknown, persist: (row: ReviewFinding) => Promise<string>): Promise<string> {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 4_000_000) throw new Error('Review journal payload is unavailable or exceeds its bounded size.');
  const context = { ...base.context, viewpoint: { ...base.context.viewpoint, snapshot: undefined } };
  const write = (id: string, text: string) => persist({ ...base, id, kind: 'note', context, text, createdAt: new Date().toISOString() });
  if (serialized.length <= 48_000) return write(base.id, serialized);
  const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
  const chunks: { id: string; sha256: string }[] = [];
  for (let start = 0; start < serialized.length; start += 20_000) {
    const data = serialized.slice(start, start + 20_000), id = crypto.randomUUID(), sha256 = await hash(data);
    await write(id, JSON.stringify({ kind: 'review.journal.chunk', journalId: base.id, index: chunks.length, sha256, data }));
    chunks.push({ id, sha256 });
  }
  return write(base.id, JSON.stringify({ kind: 'review.journal.manifest', sha256: await hash(serialized), chunks }));
}
