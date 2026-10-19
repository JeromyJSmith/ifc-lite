/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { createReviewStorage, listReviewScopes, exportReviewArchive, importReviewArchive, validateReviewArchive } from './storage';
import type { ReviewArchive } from './types';
export interface ResolutionBundle { schemaVersion: 1; kind: 'review.resolution.bundle'; exportedAt: string; archives: ReviewArchive[] }
type ArchiveStorage = Pick<ReturnType<typeof createReviewStorage>, 'listReviewScopes' | 'exportReviewArchive' | 'importReviewArchive'>;
/** All scopes include preserved source revisions; keep UI import and bundle export on one bound. */
export const MAX_RESOLUTION_BACKUP_BYTES = 256 * 1024 * 1024;
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function createResolutionArchive(storage: ArchiveStorage) {
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
  return { exportBundle, importBundle };
}
const defaults = createResolutionArchive({ listReviewScopes, exportReviewArchive, importReviewArchive });
export const exportResolutionBundle = defaults.exportBundle;
export const importResolutionBundle = defaults.importBundle;
