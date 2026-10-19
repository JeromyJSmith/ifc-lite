/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReviewFinding } from './types';
const CHUNK_CHARS = 30000;
const MAX_NOTE = 48000;
interface SourceChunk { kind: 'review.geometry.source.chunk'; index: number; text: string; sha256: string }
interface SourceManifest { kind: 'review.geometry.source'; hash: string; byteLength: number; chunks: Array<{ id: string; sha256: string }> }
async function sha256(bytes: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
function bytes(text: string): ArrayBuffer { return new TextEncoder().encode(text).buffer; }
function payload<T>(row: ReviewFinding, kind: string): T {
  let value: unknown;
  try { value = JSON.parse(row.text); } catch { throw new Error('Geometry source record is not JSON'); }
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== kind) throw new Error('Geometry source record has the wrong type');
  return value as T;
}
/** Append exact source bytes in archive-compatible notes; a manifest commits the complete set last. */
export async function saveGeometrySource(buffer: ArrayBuffer, base: ReviewFinding, persist: (row: ReviewFinding) => Promise<string>) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  // Source round trips must be byte exact; a UTF8 BOM is not silently discarded.
  const encoded = bytes(source);
  if (encoded.byteLength !== buffer.byteLength || await sha256(encoded) !== await sha256(buffer)) throw new Error('Geometry source is not canonical UTF8 text; byte-preserving storage refused');
  JSON.parse(source);
  const context = structuredClone(base.context);
  delete context.viewpoint.snapshot;
  delete context.viewpoint.snapshotData;
  const createdAt = new Date().toISOString();
  const chunks: SourceManifest['chunks'] = [];
  for (let offset = 0; offset < source.length;) {
    let end = Math.min(source.length, offset + CHUNK_CHARS);
    let part = source.slice(offset, end);
    // Keep paired UTF16 code units together so per-chunk UTF8 hashes are meaningful.
    if (end < source.length && /[\uD800-\uDBFF]/u.test(part.slice(-1))) { end--; part = source.slice(offset, end); }
    while (JSON.stringify({ text: part }).length > MAX_NOTE - 400) {
      end = offset + Math.floor((end - offset) * 0.8);
      part = source.slice(offset, end);
      if (/[\uD800-\uDBFF]/u.test(part.slice(-1))) { end--; part = source.slice(offset, end); }
    }
    const hash = await sha256(bytes(part));
    const value: SourceChunk = { kind: 'review.geometry.source.chunk', index: chunks.length, text: part, sha256: hash };
    const row: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'note', text: JSON.stringify(value), context, createdAt };
    if (row.text.length > MAX_NOTE) throw new Error('Geometry source chunk exceeds review storage bounds');
    const id = await persist(row);
    if (id !== row.id) throw new Error('Geometry source storage returned a different chunk identity');
    chunks.push({ id, sha256: hash }); offset = end;
  }
  const hash = await sha256(buffer);
  const manifest: SourceManifest = { kind: 'review.geometry.source', hash, byteLength: buffer.byteLength, chunks };
  const row: ReviewFinding = { schemaVersion: 1, id: crypto.randomUUID(), kind: 'note', text: JSON.stringify(manifest), context, createdAt, parentId: base.id };
  if (row.text.length > MAX_NOTE) throw new Error('Geometry source manifest exceeds review storage bounds');
  const manifestRef = await persist(row);
  if (manifestRef !== row.id) throw new Error('Geometry source storage returned a different manifest identity');
  return { manifestRef, hash, byteLength: buffer.byteLength, chunkCount: chunks.length };
}

/** A missing/corrupt/wrong-scope chunk cannot become a model or an undo source. */
export async function readGeometrySource(manifestRef: string, rows: ReviewFinding[]): Promise<ArrayBuffer> {
  const byId = new Map(rows.map(row => [row.id, row]));
  if (byId.size !== rows.length) throw new Error('Duplicate review record identities');
  const record = byId.get(manifestRef);
  if (!record) throw new Error('Geometry source manifest is missing');
  const manifest = payload<SourceManifest>(record, 'review.geometry.source');
  if (!/^[a-f0-9]{64}$/.test(manifest.hash) || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 1 || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0 || manifest.chunks.length > 10000) throw new Error('Invalid geometry source manifest');
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [index, chunkRef] of manifest.chunks.entries()) {
    if (!chunkRef || typeof chunkRef.id !== 'string' || seen.has(chunkRef.id)) throw new Error('Invalid or repeated geometry chunk reference');
    seen.add(chunkRef.id);
    const row = byId.get(chunkRef.id);
    if (!row || row.context.scopeId !== record.context.scopeId) throw new Error('Geometry source chunk missing or from a different review scope');
    const chunk = payload<SourceChunk>(row, 'review.geometry.source.chunk');
    if (chunk.index !== index || typeof chunk.text !== 'string' || chunk.text.length > CHUNK_CHARS || !/^[a-f0-9]{64}$/.test(chunk.sha256) || chunk.sha256 !== chunkRef.sha256 || await sha256(bytes(chunk.text)) !== chunk.sha256) throw new Error('Geometry source chunk failed integrity verification');
    parts.push(chunk.text);
  }
  const buffer = bytes(parts.join(''));
  if (buffer.byteLength !== manifest.byteLength || await sha256(buffer) !== manifest.hash) throw new Error('Geometry source failed full integrity verification');
  JSON.parse(new TextDecoder().decode(buffer));
  return buffer;
}
