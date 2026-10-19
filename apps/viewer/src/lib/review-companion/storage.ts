/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ReviewArchive, ReviewContext, ReviewEvent, ReviewFinding } from './types';

export const REVIEW_DATABASE_NAME = 'ifc-lite-review-companion';
const MAX_IMAGE = 16 * 1024 * 1024;
const MAX_ARCHIVE = 128 * 1024 * 1024;
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('Expected a plain review record');
  }
  return value as RecordValue;
}
function text(value: unknown, limit = 1000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error('Invalid review text or identifier');
  }
}
function date(value: unknown) {
  text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid review timestamp');
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid review array');
  return value;
}
function vector(value: unknown, nonzero = false) {
  const v = record(value);
  for (const key of ['x', 'y', 'z']) if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) throw new Error('Invalid viewpoint vector');
  if (nonzero && v.x === 0 && v.y === 0 && v.z === 0) throw new Error('Zero viewpoint direction');
}
function components(value: unknown) {
  for (const valueItem of array(value)) {
    const item = record(valueItem);
    for (const key of ['ifcGuid', 'authoringToolId', 'originatingSystem']) if (item[key] !== undefined) text(item[key]);
  }
}
/** Review archives are inert JSON; executable URLs and prototype keys are refused. */
function jsonSafe(value: unknown, depth = 0): void {
  if (depth > 30) throw new Error('Review data is too deeply nested');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') {
    if (value.length > MAX_IMAGE || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error('Unsafe review string');
    return;
  }
  if (Array.isArray(value)) { for (const child of array(value)) jsonSafe(child, depth + 1); return; }
  for (const [key, child] of Object.entries(record(value))) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe review key');
    jsonSafe(child, depth + 1);
  }
}
function finding(value: unknown): asserts value is ReviewFinding {
  const f = record(value);
  if (f.schemaVersion !== 1 || !['note', 'candidate'].includes(String(f.kind))) throw new Error('Unsupported review finding');
  text(f.id); text(f.text, 50000); date(f.createdAt);
  if (f.parentId !== undefined) text(f.parentId);
  if (f.location !== undefined) {
    const point = record(f.location);
    if (typeof point.x !== 'number' || !Number.isFinite(point.x) || point.x < 0 || point.x > 1 ||
      typeof point.y !== 'number' || !Number.isFinite(point.y) || point.y < 0 || point.y > 1) throw new Error('Invalid normalized screenshot location');
  }
  if (f.surfaceHit !== undefined) {
    const hit = record(f.surfaceHit); vector(hit.point);
    if (hit.coordinateSpace !== 'rendered-viewer-world' || !Number.isSafeInteger(hit.triangleIndex) || Number(hit.triangleIndex) < 0) throw new Error('Invalid native surface evidence');
  }
  const context = record(f.context);
  text(context.scopeId); date(context.capturedAt);
  if (context.mutationVersion !== undefined && (!Number.isSafeInteger(context.mutationVersion) || Number(context.mutationVersion) < 0)) throw new Error('Invalid model edit revision');
  const models = new Set<string>();
  for (const model of array(context.models)) {
    const m = record(model); text(m.id); text(m.name); text(m.sourceIdentity, 10000);
    if (models.has(m.id)) throw new Error('Duplicate model identity');
    models.add(m.id);
  }
  for (const element of array(context.elements)) {
    const e = record(element); text(e.modelId);
    if (!models.has(e.modelId) || !Number.isSafeInteger(e.expressId) || Number(e.expressId) < 1) throw new Error('Unbound review element');
    if (e.ifcGlobalId !== null) text(e.ifcGlobalId);
  }
  const view = record(context.viewpoint); text(view.guid);
  const cameras = [view.perspectiveCamera, view.orthogonalCamera].filter(v => v !== undefined);
  if (cameras.length !== 1) throw new Error('Review viewpoint requires exactly one camera');
  const camera = record(cameras[0]);
  vector(camera.cameraViewPoint); vector(camera.cameraDirection, true); vector(camera.cameraUpVector, true);
  const scale = view.perspectiveCamera ? camera.fieldOfView : camera.viewToWorldScale;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0 || (view.perspectiveCamera && scale >= 180)) throw new Error('Invalid viewpoint camera scale');
  if (camera.aspectRatio !== undefined && (typeof camera.aspectRatio !== 'number' || !Number.isFinite(camera.aspectRatio) || camera.aspectRatio <= 0)) throw new Error('Invalid camera aspect ratio');
  if (view.clippingPlanes !== undefined) for (const plane of array(view.clippingPlanes)) {
    const p = record(plane); vector(p.location); vector(p.direction, true);
  }
  if (view.lines !== undefined) for (const line of array(view.lines)) {
    const l = record(line); vector(l.startPoint); vector(l.endPoint);
  }
  if (view.components !== undefined) {
    const c = record(view.components);
    if (c.selection !== undefined) components(c.selection);
    if (c.visibility !== undefined) {
      const v = record(c.visibility);
      if (typeof v.defaultVisibility !== 'boolean') throw new Error('Invalid viewpoint visibility');
      if (v.exceptions !== undefined) components(v.exceptions);
      if (v.viewSetupHints !== undefined) for (const flag of Object.values(record(v.viewSetupHints))) {
        if (typeof flag !== 'boolean') throw new Error('Invalid viewpoint visibility hint');
      }
    }
    if (c.coloring !== undefined) for (const color of array(c.coloring)) {
      const entry = record(color);
      if (typeof entry.color !== 'string' || !/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(entry.color)) throw new Error('Invalid viewpoint color');
      components(entry.components);
    }
  }
  if (view.snapshot !== undefined && (typeof view.snapshot !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(view.snapshot) || view.snapshot.length > MAX_IMAGE)) throw new Error('Snapshot must be a bounded raster data URL');
  // A self-contained JSON backup uses snapshot data URLs, never filesystem paths or typed arrays.
  if (view.snapshotData !== undefined || view.bitmaps !== undefined) throw new Error('Use a self-contained viewpoint snapshot for review evidence');
  if (f.provider !== undefined) {
    const p = record(f.provider); text(p.model); text(p.endpoint, 10000);
    const endpoint = new URL(p.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid review provider endpoint');
  }
}
function event(value: unknown): asserts value is ReviewEvent {
  const e = record(value);
  if (e.schemaVersion !== 1 || !['confirmed', 'dismissed', 'resolved'].includes(String(e.status))) throw new Error('Unsupported review event');
  text(e.id); text(e.findingId); date(e.createdAt);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as RecordValue)[k])}`).join(',')}}`;
}
function checked<T>(value: T, validate: (value: unknown) => void): T {
  // Optional fields emitted as undefined by TypeScript callers are absent in JSON.
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_ARCHIVE) throw new Error('Review archive is too large');
  const clone: T = JSON.parse(encoded);
  jsonSafe(clone); validate(clone);
  return clone;
}

/** Validate a complete inert archive before any storage transaction begins. */
export function validateReviewArchive(input: unknown): ReviewArchive {
  return checked(input, value => {
    const a = record(value);
    if (a.schemaVersion !== 1) throw new Error('Unsupported review archive version');
    text(a.scopeId); date(a.exportedAt);
    const ids = new Set<string>();
    for (const f of array(a.findings)) {
      finding(f);
      if (f.context.scopeId !== a.scopeId || ids.has(f.id)) throw new Error('Mixed review scope or duplicate finding ID');
      ids.add(f.id);
    }
    for (const f of a.findings as ReviewFinding[]) if (f.parentId && !ids.has(f.parentId)) throw new Error('Archive parent finding is missing');
    const eventIds = new Set<string>();
    for (const e of array(a.events)) {
      event(e);
      if (!ids.has(e.findingId) || eventIds.has(e.id)) throw new Error('Orphan event or duplicate event ID');
      eventIds.add(e.id);
    }
  }) as ReviewArchive;
}

export function createReviewStorage(factory: IDBFactory = globalThis.indexedDB) {
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('IndexedDB is unavailable; review was not saved')); return; }
      const request = factory.open(REVIEW_DATABASE_NAME, 1);
      let blocked = false;
      request.onblocked = () => { blocked = true; reject(new Error('Review database upgrade is blocked by another tab')); };
      request.onerror = () => reject(request.error ?? new Error('Cannot open review database'));
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('findings', { keyPath: 'id' }).createIndex('scopeId', 'context.scopeId');
        db.createObjectStore('events', { keyPath: 'id' }).createIndex('findingId', 'findingId');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        if (blocked) db.close(); else resolve(db);
      };
    });
  }
  async function transaction<T>(mode: IDBTransactionMode, run: (tx: IDBTransaction, result: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(['findings', 'events'], mode); }
      catch (error) { db.close(); reject(error); return; }
      let result: T;
      let failure: Error | undefined;
      const fail = (error: Error) => { failure = error; tx.abort(); };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(failure ?? tx.error ?? new Error('Review transaction aborted; nothing was saved')); };
      tx.onerror = () => { if (tx.error) failure ??= tx.error; };
      try { run(tx, value => { result = value; }, fail); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  function append(tx: IDBTransaction, storeName: string, value: ReviewFinding | ReviewEvent, fail: (error: Error) => void, added: () => void) {
    const store = tx.objectStore(storeName);
    const request = store.get(value.id);
    request.onsuccess = () => {
      if (request.result === undefined) { store.add(value); added(); }
      else if (canonical(request.result) !== canonical(value)) fail(new Error(`Conflicting review record ID: ${value.id}`));
    };
  }
  async function saveFinding(input: ReviewFinding) {
    const value = checked(input, finding);
    await transaction<void>('readwrite', (tx, result, fail) => {
      if (!value.parentId) { append(tx, 'findings', value, fail, () => {}); result(); return; }
      const parent = tx.objectStore('findings').get(value.parentId);
      parent.onsuccess = () => {
        if (!parent.result || parent.result.context.scopeId !== value.context.scopeId) fail(new Error('Parent finding is missing or belongs to another review scope'));
        else append(tx, 'findings', value, fail, () => {});
      };
      result();
    });
  }
  /** Read exact evidence identities without materializing unrelated screenshots. */
  async function getFindingsByIds(ids: string[]): Promise<ReviewFinding[]> {
    if (ids.length > 10000) throw new Error('Too many requested review identities');
    const keys = [...new Set(ids)]; keys.forEach(id => text(id));
    return transaction('readonly', (tx, result) => {
      const rows: ReviewFinding[] = [];
      result(rows);
      for (const id of keys) {
        const request = tx.objectStore('findings').get(id);
        request.onsuccess = () => { if (request.result) rows.push(request.result as ReviewFinding); };
      }
    });
  }
  async function listAllFindings(): Promise<ReviewFinding[]> {
    return transaction('readonly', (tx, result) => {
      const request = tx.objectStore('findings').getAll();
      request.onsuccess = () => result(request.result as ReviewFinding[]);
    });
  }
  async function listFindings(scopeId: string): Promise<ReviewFinding[]> {
    text(scopeId);
    return transaction('readonly', (tx, result) => {
      const request = tx.objectStore('findings').index('scopeId').getAll(scopeId);
      request.onsuccess = () => result((request.result as ReviewFinding[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
    });
  }
  async function listReviewScopes(): Promise<Array<{ scopeId: string; models: ReviewContext['models']; count: number }>> {
    return transaction('readonly', (tx, result) => {
      const request = tx.objectStore('findings').getAll();
      request.onsuccess = () => {
        const scopes = new Map<string, { scopeId: string; models: ReviewContext['models']; count: number }>();
        for (const finding of request.result as ReviewFinding[]) {
          const existing = scopes.get(finding.context.scopeId);
          if (existing) existing.count++;
          else scopes.set(finding.context.scopeId, { scopeId: finding.context.scopeId, models: finding.context.models, count: 1 });
        }
        result([...scopes.values()].sort((a, b) => a.scopeId.localeCompare(b.scopeId)));
      };
    });
  }
  async function saveEvent(input: ReviewEvent) {
    const value = checked(input, event);
    await transaction<void>('readwrite', (tx, result, fail) => {
      const request = tx.objectStore('findings').get(value.findingId);
      request.onsuccess = () => {
        if (!request.result) fail(new Error('Event finding does not exist'));
        else append(tx, 'events', value, fail, () => {});
      };
      result();
    });
  }
  async function exportReviewArchive(scopeId: string): Promise<ReviewArchive> {
    text(scopeId);
    return transaction('readonly', (tx, result) => {
      const request = tx.objectStore('findings').index('scopeId').getAll(scopeId);
      request.onsuccess = () => {
        const findings = request.result as ReviewFinding[];
        const ids = new Set(findings.map(f => f.id));
        const events = tx.objectStore('events').getAll();
        events.onsuccess = () => result({ schemaVersion: 1, scopeId, exportedAt: new Date().toISOString(), findings, events: (events.result as ReviewEvent[]).filter(e => ids.has(e.findingId)) });
      };
    });
  }
  async function listEvents(scopeId: string) {
    return (await exportReviewArchive(scopeId)).events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async function importReviewArchive(input: unknown) {
    const archive = validateReviewArchive(input);
    return transaction<{ findingsAdded: number; eventsAdded: number }>('readwrite', (tx, result, fail) => {
      const counts = { findingsAdded: 0, eventsAdded: 0 };
      result(counts);
      for (const f of archive.findings) append(tx, 'findings', f, fail, () => { counts.findingsAdded++; });
      for (const e of archive.events) append(tx, 'events', e, fail, () => { counts.eventsAdded++; });
    });
  }
  return { saveFinding, getFindingsByIds, listAllFindings, listFindings, listReviewScopes, saveEvent, listEvents, exportReviewArchive, importReviewArchive };
}

const defaultStorage = createReviewStorage();
export const { saveFinding, getFindingsByIds, listAllFindings, listFindings, listReviewScopes, saveEvent, listEvents, exportReviewArchive, importReviewArchive } = defaultStorage;
