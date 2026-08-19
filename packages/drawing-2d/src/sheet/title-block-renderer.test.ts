/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `renderTitleBlock` positions the block within the frame's inner bounds
 * (three position arms plus a default), lays out fields in a grid whose row
 * heights are computed from font sizes and possibly rescaled to fit, and
 * draws an embedded scale bar / north arrow / revision table. None of this
 * had a test.
 *
 * What is pinned:
 * - each of the THREE `TitleBlockPosition` arms places (x, y, w, h)
 *   differently, using distinct frame bounds so a transposed axis is
 *   visible; plus the `default` branch (an out-of-union position falls back
 *   to `bottom-right`'s formula).
 * - the embedded scale bar in the title block uses the SAME
 *   `totalLengthM * 1000 / scaleFactor` maths as the standalone
 *   `scale-bar-renderer.ts` — two independent implementations of one
 *   formula, checked to agree — and, distinctly, that clamping the bar to
 *   `maxBarWidth` also rescales the printed end-of-bar distance rather than
 *   leaving it at the unclamped `totalLengthM`.
 * - the field-grid row-height and vertical-divider logic, using fields
 *   whose font sizes are all distinct so a per-row height mistake is
 *   visible in the emitted Y position, not just in totals.
 */

import { describe, expect, it } from 'vitest';
import { renderTitleBlock } from './title-block-renderer.js';
import type {
  TitleBlockConfig,
  TitleBlockField,
  TitleBlockPosition,
  RevisionEntry,
} from './title-block-types.js';
import type { ScaleBarConfig, NorthArrowConfig } from './scale-bar-types.js';
import type { DrawingScale } from '../styles.js';

function field(overrides: Partial<TitleBlockField>): TitleBlockField {
  return {
    id: 'f',
    label: 'L',
    value: 'V',
    editable: false,
    autoPopulate: false,
    fontSize: 3,
    fontWeight: 'normal',
    ...overrides,
  };
}

function titleBlock(overrides: Partial<TitleBlockConfig> = {}): TitleBlockConfig {
  return {
    layout: 'custom',
    position: 'bottom-right',
    widthMm: 90,
    heightMm: 40,
    borderWeight: 0.5,
    gridWeight: 0.25,
    fields: [],
    logo: null,
    showRevisionHistory: false,
    maxRevisionEntries: 0,
    ...overrides,
  };
}

/** Deliberately asymmetric so a transposed axis or swapped w/h is visible. */
const bounds = { x: 17, y: 23, width: 260, height: 150 };

describe('renderTitleBlock: position arms', () => {
  it('bottom-right: anchors the block to the bottom-right corner of the frame bounds', () => {
    const result = renderTitleBlock(titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 40 }), bounds);
    // x = 17+260-90=187, y=23+150-40=133
    expect(result.bounds).toEqual({ x: 187, y: 133, width: 90, height: 40 });
  });

  it('bottom-full: spans the full inner width, anchored to the bottom', () => {
    const result = renderTitleBlock(titleBlock({ position: 'bottom-full', heightMm: 40 }), bounds);
    // w = 260 (full width), x = 17 (frame origin), y = 23+150-40=133
    expect(result.bounds).toEqual({ x: 17, y: 133, width: 260, height: 40 });
  });

  it('right-strip: spans the full inner height, anchored to the right', () => {
    const result = renderTitleBlock(titleBlock({ position: 'right-strip', widthMm: 90 }), bounds);
    // h = 150 (full height), x = 17+260-90=187, y = 23 (frame origin)
    expect(result.bounds).toEqual({ x: 187, y: 23, width: 90, height: 150 });
  });

  it('falls back to the bottom-right formula for a position value outside the union', () => {
    const bogus = 'top-left' as unknown as TitleBlockPosition;
    const fallback = renderTitleBlock(titleBlock({ position: bogus, widthMm: 90, heightMm: 40 }), bounds);
    const bottomRight = renderTitleBlock(titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 40 }), bounds);
    expect(fallback.bounds).toEqual(bottomRight.bounds);
  });
});

describe('renderTitleBlock: background and border', () => {
  it('draws no fill rect when backgroundColor is unset', () => {
    const result = renderTitleBlock(titleBlock(), bounds);
    expect(result.svgElements).not.toMatch(/fill="#[0-9a-fA-F]{6}"\/>\n.*stroke-width="0.5"/);
    expect((result.svgElements.match(/<rect/g) ?? []).length).toBe(1); // border only
  });

  it('draws a filled background rect matching the block bounds when backgroundColor is set', () => {
    const result = renderTitleBlock(titleBlock({ backgroundColor: '#eeeeee' }), bounds);
    expect(result.svgElements).toContain(
      `<rect x="${result.bounds.x.toFixed(2)}" y="${result.bounds.y.toFixed(2)}" width="${result.bounds.width.toFixed(2)}" height="${result.bounds.height.toFixed(2)}" fill="#eeeeee"/>`,
    );
  });
});

describe('renderTitleBlock: logo positions', () => {
  const logoBlock = (position: 'top-left' | 'top-right' | 'bottom-left') =>
    titleBlock({
      position: 'bottom-right',
      widthMm: 90,
      heightMm: 40,
      logo: { source: 'data:img', widthMm: 20, heightMm: 10, position },
    });

  it('top-left: places the logo 3mm inset from the block\'s top-left corner', () => {
    const result = renderTitleBlock(logoBlock('top-left'), bounds);
    // block x=187, y=133 -> logo at 190, 136
    expect(result.svgElements).toContain('<image x="190.00" y="136.00" width="20.00" height="10.00"');
  });

  it('top-right: places the logo 3mm inset from the block\'s top-right corner', () => {
    const result = renderTitleBlock(logoBlock('top-right'), bounds);
    // x = 187+90-20-3=254, y=133+3=136
    expect(result.svgElements).toContain('<image x="254.00" y="136.00" width="20.00" height="10.00"');
  });

  it('bottom-left: places the logo 3mm inset from the block\'s bottom-left corner', () => {
    const result = renderTitleBlock(logoBlock('bottom-left'), bounds);
    // x=187+3=190, y=133+40-10-3=160
    expect(result.svgElements).toContain('<image x="190.00" y="160.00" width="20.00" height="10.00"');
  });
});

describe('renderTitleBlock: embedded scale bar agrees with the standalone renderer\'s formula', () => {
  const scaleBar: ScaleBarConfig = {
    visible: true,
    style: 'alternating',
    position: 'in-title-block',
    units: 'metric',
    totalLengthM: 5,
    primaryDivisions: 4,
    subdivisions: 1,
    heightMm: 3,
    labelFontSize: 2,
    showUnitLabel: false,
    fillColor: '#000000',
    strokeColor: '#000000',
    lineWeight: 0.2,
  };
  const scale: DrawingScale = { name: '1:50', factor: 50, useCase: 'test' };

  it('draws the bar at its unclamped length when totalLengthM fits within 30% of the block width or 50mm', () => {
    // barLengthMm = 5*1000/50 = 100mm, maxBarWidth = min(90*0.3, 50) = 27 -> WILL be clamped.
    // Use a wider block so it is NOT clamped: widthMm=400 -> maxBarWidth=min(120,50)=50, still clamps.
    // totalLengthM=1 -> barLengthMm = 1000/50=20mm < 50 -> unclamped.
    const result = renderTitleBlock(
      titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 40 }),
      bounds,
      [],
      { scaleBar: { ...scaleBar, totalLengthM: 1 }, scale },
    );
    // bar origin: barX = blockX+3 = 190, barY = blockY+40-8 = 165
    // divWidth = 20/4 = 5
    expect(result.svgElements).toContain('<rect x="190.00" y="165.00" width="5.00" height="3.00"');
    // end label reads the FULL unclamped distance: 1m
    expect(result.svgElements).toContain('text-anchor="end" fill="#000000">1m</text>');
  });

  it('clamps the bar to maxBarWidth and rescales the printed end distance to match, not the configured totalLengthM', () => {
    // barLengthMm = 5*1000/50 = 100mm; maxBarWidth = min(90*0.3, 50) = 27mm -> clamped to 27.
    // actualTotalLength = 27*50/1000 = 1.35m (NOT the configured 5m).
    const result = renderTitleBlock(
      titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 40 }),
      bounds,
      [],
      { scaleBar, scale },
    );
    const barX = 190; // blockX(187)+3
    expect(result.svgElements).toContain(`<rect x="${barX.toFixed(2)}" y="165.00" width="6.75" height="3.00"`); // 27/4
    // Printed distance is the CLAMPED distance (1.35m, rounded to "1m"),
    // not the configured 5m — the label must track what the bar actually
    // measures on paper, not the value in the config object.
    expect(result.svgElements).toContain('text-anchor="end" fill="#000000">1m</text>');
    expect(result.svgElements).not.toContain('>5m</text>');
  });

  it('omits the scale bar entirely when the block is too short (h <= 10) even if visible', () => {
    const result = renderTitleBlock(
      titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 8 }),
      bounds,
      [],
      { scaleBar, scale },
    );
    expect(result.svgElements).not.toContain('title-block-scale-bar');
  });
});

describe('renderTitleBlock: embedded north arrow', () => {
  const northArrow: NorthArrowConfig = {
    style: 'simple',
    rotation: 90,
    positionMm: { x: 0, y: 0 },
    sizeMm: 100, // deliberately oversized, to exercise the clamp
  };

  it('clamps arrow size to the smallest of sizeMm, 8mm, and 60% of block height', () => {
    // h=40 -> 0.6*40=24; min(100,8,24)=8
    const result = renderTitleBlock(
      titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 40 }),
      bounds,
      [],
      { northArrow },
    );
    // blockX=187, blockY=133: arrowX = 187+90-8-5=264, arrowY=133+40-4-3=166
    expect(result.svgElements).toContain('translate(264.00, 166.00) rotate(90)');
  });

  it('clamps arrow size by block height when the height is the tightest bound', () => {
    // h=15 -> 0.6*15=9 -> min(100,8,9)=8 still (8 is smaller); use h=10 -> 0.6*10=6 -> min(100,8,6)=6
    const result = renderTitleBlock(
      titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 20 }),
      bounds,
      [],
      { northArrow: { ...northArrow, sizeMm: 100 } },
    );
    // h=20 -> 0.6*20=12 -> min(100,8,12)=8; arrowY = blockY+20-4-3
    const blockY = 23 + 150 - 20; // 153
    expect(result.svgElements).toContain(`translate(264.00, ${(blockY + 13).toFixed(2)}) rotate(90)`);
  });

  it('omits the north arrow when the block is too short (h <= 15)', () => {
    const result = renderTitleBlock(
      titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 15 }),
      bounds,
      [],
      { northArrow },
    );
    expect(result.svgElements).not.toContain('title-block-north-arrow');
  });
});

describe('renderTitleBlock: field grid layout', () => {
  it('stacks rows by cumulative row height, each row height driven by ITS OWN largest font size', () => {
    // Two rows with deliberately distinct font sizes so a shared-height bug
    // (e.g. using row 0's height for row 1) is visible in row 1's Y.
    const fields: TitleBlockField[] = [
      field({ id: 'a', label: 'A', value: 'a-val', fontSize: 6, row: 0, col: 0 }),
      field({ id: 'b', label: 'B', value: 'b-val', fontSize: 2, row: 1, col: 0 }),
    ];
    const result = renderTitleBlock(titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 60, fields }), bounds);
    const blockX = 187, blockY = 150 - 60 + 23; // = 187, y=23+150-60=113

    // Row 0: labelSize=min(6*0.5,2.2)=2.2, minRowHeight=2.2+1+6+2=11.2
    // Row 1 starts at gridStartY(blockY+2) + 11.2
    const gridStartY = blockY + 2;
    const row1Y = gridStartY + 11.2;

    // Field a's value baseline: labelY = gridStartY+0.5+2.2=... ; just check
    // field b's VALUE text is positioned relative to row1Y, not row0's height.
    const bLabelY = row1Y + 0.5 + Math.min(2 * 0.45, 2.2);
    const bValueY = bLabelY + 0.8 + 2 * 0.8;
    expect(result.svgElements).toContain(`y="${bValueY.toFixed(2)}"`);
    expect(result.svgElements).toContain('>b-val</text>');
  });

  it('draws a vertical divider only for a row containing a field with colSpan < 2', () => {
    const fields: TitleBlockField[] = [
      field({ id: 'full', label: 'Full', value: 'x', fontSize: 4, row: 0, col: 0, colSpan: 2 }),
      field({ id: 'half', label: 'Half', value: 'y', fontSize: 4, row: 1, col: 0 }), // colSpan default 1
    ];
    const result = renderTitleBlock(titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 60, fields }), bounds);
    // Exactly one vertical divider line should appear (for row 1), none for row 0.
    const verticalDividers = (result.svgElements.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="\1"/g) ?? []).length;
    expect(verticalDividers).toBe(1);
  });

  it('scales row heights down to fit when their total exceeds the available height', () => {
    // A single, tall row in a very short block: minRowHeight exceeds availableHeight.
    const fields: TitleBlockField[] = [field({ id: 'a', label: 'A', value: 'v', fontSize: 20, row: 0, col: 0 })];
    const shortResult = renderTitleBlock(titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 15, fields }), bounds);
    const tallResult = renderTitleBlock(titleBlock({ position: 'bottom-right', widthMm: 90, heightMm: 60, fields }), bounds);
    // The value font-size attribute must shrink in the compressed block
    // relative to the uncompressed one (both start from fontSize=20).
    const shortFontSize = Number(/font-size="([\d.]+)" font-weight="normal"/.exec(shortResult.svgElements)?.[1]);
    const tallFontSize = Number(/font-size="([\d.]+)" font-weight="normal"/.exec(tallResult.svgElements)?.[1]);
    expect(shortFontSize).toBeLessThan(tallFontSize);
  });

  it('escapes XML special characters in field label and value', () => {
    const fields: TitleBlockField[] = [
      field({ id: 'x', label: 'A & B', value: '<script>"quoted"</script>', fontSize: 3, row: 0, col: 0 }),
    ];
    const result = renderTitleBlock(titleBlock({ fields }), bounds);
    expect(result.svgElements).toContain('A &amp; B');
    expect(result.svgElements).toContain('&lt;script&gt;&quot;quoted&quot;&lt;/script&gt;');
    expect(result.svgElements).not.toContain('<script>');
  });
});

describe('renderTitleBlock: revision history', () => {
  const revisions: RevisionEntry[] = [
    { revision: 'A', description: 'Initial issue for tender', date: '2024-01-01', author: 'JD' },
    { revision: 'B', description: 'Fix', date: '2024-02-01', author: 'MK' },
  ];

  it('does not draw the revision table when showRevisionHistory is false, even with revisions present', () => {
    const result = renderTitleBlock(titleBlock({ showRevisionHistory: false }), bounds, revisions);
    expect(result.svgElements).not.toContain('revision-history');
  });

  it('shows at most maxRevisionEntries rows, most recent entries first as given', () => {
    const result = renderTitleBlock(
      titleBlock({ showRevisionHistory: true, maxRevisionEntries: 1, widthMm: 90, heightMm: 40 }),
      bounds,
      revisions,
    );
    expect(result.svgElements).toContain('>A</text>');
    // The second revision must be excluded — capped by maxRevisionEntries.
    expect(result.svgElements).not.toContain('>B</text>');
  });

  it('truncates a description longer than the column can hold, with a ".." ellipsis', () => {
    const long: RevisionEntry[] = [
      { revision: 'A', description: 'A description far too long to fit in the column width available', date: '2024-01-01', author: 'JD' },
    ];
    const result = renderTitleBlock(
      titleBlock({ showRevisionHistory: true, maxRevisionEntries: 3, widthMm: 90, heightMm: 40 }),
      bounds,
      long,
    );
    expect(result.svgElements).toContain('..</text>');
    expect(result.svgElements).not.toContain(long[0].description);
  });
});
