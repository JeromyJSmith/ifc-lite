/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { createReviewStorage, listReviewScopes, exportReviewArchive, importReviewArchive, validateReviewArchive, MAX_REVIEW_ARCHIVE_BYTES } from './storage';
import type { ReviewArchive } from './types';
export interface ResolutionBundle { schemaVersion: 1; kind: 'review.resolution.bundle'; exportedAt: string; archives: ReviewArchive[] }
type ArchiveStorage = Pick<ReturnType<typeof createReviewStorage>, 'listReviewScopes' | 'exportReviewArchive' | 'importReviewArchive'>;
/** All scopes include preserved source revisions; keep UI import and bundle export on one bound. */
export const MAX_RESOLUTION_BACKUP_BYTES = MAX_REVIEW_ARCHIVE_BYTES;
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function createResolutionArchive(storage: ArchiveStorage) {
  async function exportBlob(): Promise<Blob> {
    // Serialize one persisted row at a time. Whole-bundle stringify plus the
    // UI's second pretty-print held several copies of every image/source.
    const parts: Blob[] = []; let size = 0;
    const add = (text: string) => {
      const part = new Blob([text]); size += part.size;
      if (size > MAX_RESOLUTION_BACKUP_BYTES) throw new Error('Resolution backup exceeds the supported archive size. Existing review data remains saved.');
      parts.push(part);
    };
    add(`{"schemaVersion":1,"kind":"review.resolution.bundle","exportedAt":${JSON.stringify(new Date().toISOString())},"archives":[`);
    let firstScope = true;
    for (const scope of await storage.listReviewScopes()) {
      const archive = await storage.exportReviewArchive(scope.scopeId);
      if (!firstScope) add(','); firstScope = false;
      add(`{"schemaVersion":1,"scopeId":${JSON.stringify(archive.scopeId)},"exportedAt":${JSON.stringify(archive.exportedAt)},"findings":[`);
      for (const [index, row] of archive.findings.entries()) { if (index) add(','); add(JSON.stringify(row)); }
      add('],"events":[');
      for (const [index, row] of archive.events.entries()) { if (index) add(','); add(JSON.stringify(row)); }
      add(']}');
    }
    add(']}');
    return new Blob(parts, { type: 'application/json' });
  }
  async function exportParts(maxBytes = MAX_RESOLUTION_BACKUP_BYTES): Promise<Blob[]> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > MAX_RESOLUTION_BACKUP_BYTES) throw new Error('Invalid backup part size.');
    const exportedAt = new Date().toISOString();
    const header = new Blob([`{"schemaVersion":1,"kind":"review.resolution.bundle","exportedAt":${JSON.stringify(exportedAt)},"archives":[`]);
    const tail = new Blob([']}']);
    const output: Blob[] = []; let archives: Blob[] = [], size = header.size + tail.size;
    const finish = () => { output.push(new Blob([header, ...archives, tail], { type: 'application/json' })); archives = []; size = header.size + tail.size; };
    // Preserve complete scopes, including parents/events/source chunks. All
    // storage reads finish before any download can begin, so read failure never
    // presents a partial set as a finished backup.
    for (const scope of await storage.listReviewScopes()) {
      const archive = await storage.exportReviewArchive(scope.scopeId);
      const chunks: Blob[] = [new Blob([`{"schemaVersion":1,"scopeId":${JSON.stringify(archive.scopeId)},"exportedAt":${JSON.stringify(archive.exportedAt)},"findings":[`])];
      for (const [index, row] of archive.findings.entries()) chunks.push(new Blob([index ? ',' : '', JSON.stringify(row)]));
      chunks.push(new Blob(['],"events":[']));
      for (const [index, row] of archive.events.entries()) chunks.push(new Blob([index ? ',' : '', JSON.stringify(row)]));
      chunks.push(new Blob([']}']));
      const blob = new Blob(chunks);
      if (header.size + blob.size + tail.size > maxBytes) throw new Error(`Review scope ${scope.scopeId} exceeds the backup part limit. Existing review data remains saved.`);
      if (size + blob.size + (archives.length ? 1 : 0) > maxBytes) finish();
      if (archives.length) { archives.push(new Blob([','])); size++; }
      archives.push(blob); size += blob.size;
    }
    if (archives.length || !output.length) finish();
    return output;
  }
  async function exportBundle(): Promise<ResolutionBundle> {
    const archives = await Promise.all((await storage.listReviewScopes()).map(scope => storage.exportReviewArchive(scope.scopeId)));
    const bundle: ResolutionBundle = { schemaVersion: 1, kind: 'review.resolution.bundle', exportedAt: new Date().toISOString(), archives };
    if (new Blob([JSON.stringify(bundle)]).size > MAX_RESOLUTION_BACKUP_BYTES) throw new Error('Resolution backup exceeds the supported archive size. Existing review data remains saved.');
    return bundle;
  }
  async function importBundle(input: unknown) {
    const encoded = JSON.stringify(input);
    if (!encoded || new Blob([encoded]).size > MAX_RESOLUTION_BACKUP_BYTES) throw new Error('Resolution backup is unavailable or exceeds the supported archive size.');
    const clone: unknown = JSON.parse(encoded);
    const object = clone as Partial<ResolutionBundle> | null;
    let archives: ReviewArchive[];
    if (object && typeof object === 'object' && 'kind' in object) {
      if (object.kind !== 'review.resolution.bundle' || object.schemaVersion !== 1 || typeof object.exportedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(object.exportedAt)
        || !Number.isFinite(Date.parse(object.exportedAt)) || !Array.isArray(object.archives) || object.archives.length > 1000) throw new Error('Invalid resolution backup bundle.');
      const scopes = new Set<string>(); archives = [];
      for (const archive of object.archives) {
        const checked = validateReviewArchive(archive);
        if (scopes.has(checked.scopeId)) throw new Error('Duplicate review scope in resolution backup.');
        scopes.add(checked.scopeId); archives.push(checked);
      }
    } else archives = [validateReviewArchive(clone)];
    // Check all bundle and existing IDs before the first live write. Identical
    // overlapping legacy imports are idempotent; conflicts never overwrite work.
    const findings = new Map<string, string>(), events = new Map<string, string>();
    const check = (archive: ReviewArchive) => {
      for (const [rows, known] of [[archive.findings, findings], [archive.events, events]] as const) for (const row of rows) {
        const value = canonical(row), previous = known.get(row.id);
        if (previous !== undefined && previous !== value) throw new Error(`Conflicting review record ID: ${row.id}`);
        known.set(row.id, value);
      }
    };
    for (const scope of await storage.listReviewScopes()) check(await storage.exportReviewArchive(scope.scopeId));
    for (const archive of archives) check(archive);
    const counts = { scopesImported: archives.length, findingsAdded: 0, eventsAdded: 0 };
    // Each scope is an existing atomic append-only transaction. A storage failure
    // preserves completed scopes and an identical retry completes the remainder.
    for (const archive of archives) { const added = await storage.importReviewArchive(archive); counts.findingsAdded += added.findingsAdded; counts.eventsAdded += added.eventsAdded; }
    return counts;
  }
  return { exportBundle, exportBlob, exportParts, importBundle };
}
const defaults = createResolutionArchive({ listReviewScopes, exportReviewArchive, importReviewArchive });
export const exportResolutionBundle = defaults.exportBundle;
export const exportResolutionBlob = defaults.exportBlob;
export const importResolutionBundle = defaults.importBundle;

export const exportResolutionParts = defaults.exportParts;
