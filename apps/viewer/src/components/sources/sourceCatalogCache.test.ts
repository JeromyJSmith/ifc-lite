/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the catalog cache gate. Two things are pinned here:
 *
 *  - `persistCompleteCatalog` only writes when BOTH the container page and the
 *    file page carry no cursor. `sourceCatalogPaging.ts` documents
 *    `cursor === undefined` as "no more" for exactly this reason: a partial
 *    page persisted as if it were the whole area would silently truncate the
 *    file list next session, with no indication to the user. All four
 *    cursor-undefined/defined combinations are exercised so a fix to one arm
 *    of the `&&` can't hide behind the other.
 *  - `isCatalogCacheable` is a two-flag AND. Each flag is flipped
 *    independently so a bug that only checks one of the two capabilities is
 *    caught.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderCapabilities, SourceContainer, SourceFile } from '@ifc-lite/plugin-api';
import type { PagedItems } from './sourceCatalogPaging.js';
import {
  isCatalogCacheable,
  persistCompleteCatalog,
  readCachedCatalog,
  type CatalogCacheScope,
} from './sourceCatalogCache.js';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const localStorageMock = new MemoryStorage();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: localStorageMock,
});

beforeEach(() => {
  localStorageMock.clear();
});

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    containerListing: 'flat-subtree',
    listFilesIsRecursive: true,
    revisionHistory: false,
    downloadHistoricalRevisions: false,
    changeDetection: false,
    search: false,
    ...overrides,
  } as ProviderCapabilities;
}

const scope: CatalogCacheScope = {
  providerName: 'acme-provider',
  projectId: 'proj-1',
  fileAreaId: 'area-1',
};

const container: SourceContainer = { id: 'folder-1', name: 'Structural' };
const sourceFile: SourceFile = {
  id: 'file-1',
  name: 'model.ifc',
  containerId: 'folder-1',
  currentRevisionId: 'rev-42',
};

function page<T>(items: readonly T[], cursor: string | undefined): PagedItems<T> {
  return cursor === undefined ? { items } : { items, cursor };
}

describe('isCatalogCacheable', () => {
  it('is cacheable when both flags hold', () => {
    assert.equal(isCatalogCacheable(capabilities()), true);
  });

  it('is not cacheable when containerListing is direct-children, even with a recursive file listing', () => {
    assert.equal(
      isCatalogCacheable(capabilities({ containerListing: 'direct-children', listFilesIsRecursive: true })),
      false,
    );
  });

  it('is not cacheable when listFilesIsRecursive is false, even with a flat-subtree container listing', () => {
    assert.equal(
      isCatalogCacheable(capabilities({ containerListing: 'flat-subtree', listFilesIsRecursive: false })),
      false,
    );
  });

  it('is not cacheable when neither flag holds', () => {
    assert.equal(
      isCatalogCacheable(capabilities({ containerListing: 'direct-children', listFilesIsRecursive: false })),
      false,
    );
  });
});

describe('persistCompleteCatalog', () => {
  it('writes when both the container page and the file page carry no cursor', () => {
    const containers = new Map([[scope.fileAreaId, page([container], undefined)]]);
    const files = new Map([[scope.fileAreaId, page([sourceFile], undefined)]]);

    const result = persistCompleteCatalog(scope, containers, files);

    assert.notEqual(result, null);
    const cached = readCachedCatalog(scope);
    assert.notEqual(cached, null);
  });

  it('does not write when the container page still has a cursor', () => {
    const containers = new Map([[scope.fileAreaId, page([container], 'next-container-page')]]);
    const files = new Map([[scope.fileAreaId, page([sourceFile], undefined)]]);

    const result = persistCompleteCatalog(scope, containers, files);

    assert.equal(result, null);
    assert.equal(readCachedCatalog(scope), null);
  });

  it('does not write when the file page still has a cursor', () => {
    const containers = new Map([[scope.fileAreaId, page([container], undefined)]]);
    const files = new Map([[scope.fileAreaId, page([sourceFile], 'next-file-page')]]);

    const result = persistCompleteCatalog(scope, containers, files);

    assert.equal(result, null);
    assert.equal(readCachedCatalog(scope), null);
  });

  it('does not write when both pages still have a cursor', () => {
    const containers = new Map([[scope.fileAreaId, page([container], 'next-container-page')]]);
    const files = new Map([[scope.fileAreaId, page([sourceFile], 'next-file-page')]]);

    const result = persistCompleteCatalog(scope, containers, files);

    assert.equal(result, null);
    assert.equal(readCachedCatalog(scope), null);
  });

  it('does not write, and does not throw, when the scope is missing from either map', () => {
    const containers = new Map<string, PagedItems<SourceContainer>>();
    const files = new Map([[scope.fileAreaId, page([sourceFile], undefined)]]);

    assert.equal(persistCompleteCatalog(scope, containers, files), null);
  });
});

describe('readCachedCatalog', () => {
  it('round-trips distinct, non-default values written by persistCompleteCatalog', () => {
    const containers = new Map([
      [scope.fileAreaId, page([container, { id: 'folder-2', name: 'MEP', parentId: 'folder-1' }], undefined)],
    ]);
    const files = new Map([
      [
        scope.fileAreaId,
        page(
          [
            sourceFile,
            {
              id: 'file-2',
              name: 'services.ifc',
              containerId: 'folder-2',
              currentRevisionId: 'rev-7',
              sizeBytes: 12345,
            },
          ],
          undefined,
        ),
      ],
    ]);

    persistCompleteCatalog(scope, containers, files);
    const cached = readCachedCatalog(scope);

    assert.notEqual(cached, null);
    assert.deepEqual(
      [...cached!.containersByParent.get(scope.fileAreaId)!.items],
      [container, { id: 'folder-2', name: 'MEP', parentId: 'folder-1' }],
    );
    assert.deepEqual(
      [...cached!.filesByContainer.get(scope.fileAreaId)!.items],
      [
        sourceFile,
        {
          id: 'file-2',
          name: 'services.ifc',
          containerId: 'folder-2',
          currentRevisionId: 'rev-7',
          sizeBytes: 12345,
        },
      ],
    );
  });

  it('reports a cache miss as null, not an empty catalog', () => {
    assert.equal(readCachedCatalog(scope), null);
  });

  it('reports a corrupt cache entry as null, not a default or partial catalog', () => {
    // Same shape-check `loadSourceCatalogCache` (persistence.ts) applies:
    // an element missing a field the UI dereferences must fail the whole
    // entry, not silently pass through a malformed record.
    localStorage.setItem(
      `ifc-lite-source-catalog:${scope.providerName}:${scope.projectId}:${scope.fileAreaId}`,
      JSON.stringify({
        version: 2,
        providerId: scope.providerName,
        projectId: scope.projectId,
        fileAreaId: scope.fileAreaId,
        updatedAt: Date.now(),
        folders: [{ id: 'folder-1' }], // missing `name`
        files: [],
      }),
    );

    assert.equal(readCachedCatalog(scope), null);
  });
});
