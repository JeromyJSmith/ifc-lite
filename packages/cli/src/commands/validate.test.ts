/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reference-integrity validation rule: `#N` references that point at an
 * expressId with no entity in the file must be reported (per referencing
 * entity, attribute slot, and missing target), while `#N`-looking sequences
 * inside string literals must not. Proven gap: a text scan caught planted
 * dangling refs that `ifc-lite validate` missed entirely.
 *
 * Regression suite for PR #1868 (world-gym benchmark surfaced the gap: the
 * kernel-oracle baseline scored F1=0 on 94 planted dangling refs).
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { computeValidationIssues, collectDanglingReferences } from './validate.js';

function buildIfc(dataLines: string[]): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...dataLines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

async function parse(content: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(content);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new IfcParser().parseColumnar(buffer);
}

const CLEAN_LINES = [
  "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
  "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,$,$,$,$,$,$);",
  "#3=IFCBUILDING('0Bldg_GUID_00000001',$,'Building',$,$,$,$,$,$,$,$,$);",
  "#4=IFCBUILDINGSTOREY('0Storey_GUID_000001',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);",
  // Name contains '#123' and an escaped quote before '#77': neither is a reference.
  "#5=IFCWALL('0Wall_GUID_00000001',$,'It''s wall #123 and #77',$,$,$,$,$,$);",
  '#6=IFCRELAGGREGATES(\'0RelAgg_GUID_000001\',$,$,$,#1,(#2,#3));',
];

const DANGLING_LINES = [
  "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
  "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,$,$,$,$,$,$);",
  "#3=IFCBUILDING('0Bldg_GUID_00000001',$,'Building',$,$,$,$,$,$,$,$,$);",
  "#4=IFCBUILDINGSTOREY('0Storey_GUID_000001',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);",
  // OwnerHistory (attribute slot 1) points at #9999, which does not exist.
  "#5=IFCWALL('0Wall_GUID_00000001',#9999,'Wall #123',$,$,$,$,$,$);",
  // RelatedObjects list (attribute slot 5) contains dangling #8888.
  '#6=IFCRELAGGREGATES(\'0RelAgg_GUID_000001\',$,$,$,#1,(#2,#8888));',
];

describe('collectDanglingReferences', () => {
  it('finds each dangling reference with entity id, attribute slot, and missing target', async () => {
    const store = await parse(buildIfc(DANGLING_LINES));
    const dangling = collectDanglingReferences(store)
      .sort((a, b) => a.entityId - b.entityId);

    expect(dangling).toHaveLength(2);
    expect(dangling[0]).toMatchObject({
      entityId: 5,
      entityType: 'IFCWALL',
      attributeIndex: 1,
      target: 9999,
    });
    expect(dangling[1]).toMatchObject({
      entityId: 6,
      entityType: 'IFCRELAGGREGATES',
      attributeIndex: 5,
      target: 8888,
    });
  });

  it('reports nothing on a clean file (and ignores #N inside string literals)', async () => {
    const store = await parse(buildIfc(CLEAN_LINES));
    expect(collectDanglingReferences(store)).toHaveLength(0);
  });
});

describe('computeValidationIssues reference-integrity rule', () => {
  it('emits one error per dangling reference and flips the file invalid', async () => {
    const store = await parse(buildIfc(DANGLING_LINES));
    const issues = computeValidationIssues(store);
    const refIssues = issues.filter(i => i.rule === 'reference-integrity');

    expect(refIssues).toHaveLength(2);
    for (const issue of refIssues) {
      expect(issue.severity).toBe('error');
      expect(issue.message).toContain('references missing entity');
    }
    // Display names render in IFC PascalCase, not the raw STEP token.
    expect(refIssues.map(i => i.message).join('\n')).toContain('IfcWall');
    expect(refIssues.map(i => i.message).join('\n')).not.toContain('IFCWALL');
    const targets = refIssues.map(i => i.target).sort();
    expect(targets).toEqual([8888, 9999]);
    // Errors present means the validate command reports the file as invalid.
    expect(issues.some(i => i.severity === 'error')).toBe(true);
  });

  it('stays quiet on the clean twin', async () => {
    const store = await parse(buildIfc(CLEAN_LINES));
    const issues = computeValidationIssues(store);
    expect(issues.filter(i => i.rule === 'reference-integrity')).toHaveLength(0);
  });
});

describe('versioned spatial validation profiles', () => {
  const project = "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);";
  const site = "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,$,$,$,$,$,$);";

  it('keeps the building-v1 default building and storey requirements', async () => {
    const issues = computeValidationIssues(await parse(buildIfc([project, site])));
    expect(issues.filter(i => i.rule === 'required-entity').map(i => i.message)).toEqual(['Missing required entity: IFCBUILDING']);
    expect(issues.some(i => i.rule === 'has-storeys')).toBe(true);
    expect(computeValidationIssues(await parse(buildIfc(CLEAN_LINES))).filter(i => i.severity === 'error')).toEqual([]);
  });

  it('accepts a site-rooted model without inventing a building or storey', async () => {
    const issues = computeValidationIssues(await parse(buildIfc([project, site])), 'site-v1');
    expect(issues.filter(i => i.severity === 'error' || i.rule === 'has-storeys')).toEqual([]);
  });

  it('accepts site-rooted infrastructure and still requires one project', async () => {
    const infra = buildIfc([project, site, "#3=IFCROAD('0Road_GUID_00000001',$,'Road',$,$,$,$,$,$);"]).replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3_ADD2'))");
    expect(computeValidationIssues(await parse(infra), 'site-v1').filter(i => i.severity === 'error')).toEqual([]);
    const missing = computeValidationIssues(await parse(buildIfc([site])), 'site-v1');
    expect(missing.filter(i => i.rule === 'required-entity').map(i => i.message)).toEqual(['Missing required entity: IFCPROJECT']);
  });

  it('keeps reference integrity in site-v1', async () => {
    const dangling = buildIfc([project, site, "#3=IFCRELAGGREGATES('0RelAgg_GUID_000001',$,$,$,#1,(#9999));"]);
    expect(computeValidationIssues(await parse(dangling), 'site-v1').some(i => i.rule === 'reference-integrity' && i.severity === 'error')).toBe(true);
  });
});
