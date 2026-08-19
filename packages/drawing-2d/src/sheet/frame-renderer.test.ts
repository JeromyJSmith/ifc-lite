/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `renderFrame` draws the outer/inner border rectangles, the A-H/1-8 zone
 * references, and the fold/trim marks that a printed sheet needs. None of
 * these were under test, so the assertions below pin the actual coordinate
 * arithmetic rather than merely checking that some SVG comes out:
 *
 * - outer/inner bounds are derived from FOUR independent margins plus a
 *   binding margin and a border gap; a fixture with all-equal margins can't
 *   tell a transposed left/right from a transposed top/bottom, so every
 *   margin below is a distinct value.
 * - `innerBounds` (the return value consumers place the drawing content
 *   into) must agree with the inner `<rect>` actually drawn in the SVG —
 *   two structures over the same domain.
 * - zone reference letters/numbers and their tick marks are placed by a
 *   formula independent of the border-drawing formula; both are checked.
 * - fold marks and trim marks are each a distinct arm, exercised on their
 *   own fixtures.
 */

import { describe, expect, it } from 'vitest';
import { renderFrame } from './frame-renderer.js';
import type { PaperSizeDefinition } from './paper-sizes.js';
import type { DrawingFrame } from './frame-types.js';

function paper(overrides: Partial<PaperSizeDefinition> = {}): PaperSizeDefinition {
  return {
    id: 'TEST',
    name: 'Test paper',
    category: 'custom',
    widthMm: 300,
    heightMm: 200,
    orientation: 'landscape',
    defaultMarginMm: 10,
    ...overrides,
  };
}

function frame(overrides: Partial<DrawingFrame> = {}): DrawingFrame {
  return {
    style: 'custom',
    margins: { top: 5, right: 7, bottom: 11, left: 13, bindingMargin: 3 },
    border: {
      outerLineWeight: 0.7,
      innerLineWeight: 0.35,
      borderGap: 4,
      showFoldMarks: false,
      showTrimMarks: false,
    },
    showZoneReferences: false,
    horizontalZones: 0,
    verticalZones: 0,
    zoneFontSize: 3,
    ...overrides,
  };
}

/** Extract the numeric x/y/width/height of every plain `<rect .../>` line. */
function rects(svg: string): Array<{ x: number; y: number; width: number; height: number }> {
  const out: Array<{ x: number; y: number; width: number; height: number }> = [];
  const re = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    out.push({ x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) });
  }
  return out;
}

describe('renderFrame: outer and inner border geometry', () => {
  it('derives outer bounds from all four margins plus the binding margin, independently', () => {
    const p = paper({ widthMm: 300, heightMm: 200 });
    const f = frame();
    const result = renderFrame(p, f);

    // outerX = left + bindingMargin = 13 + 3 = 16
    // outerY = top = 5
    // outerW = 300 - 13 - 7 - 3 = 277
    // outerH = 200 - 5 - 11 = 184
    const [outer] = rects(result.svgElements);
    expect(outer).toEqual({ x: 16, y: 5, width: 277, height: 184 });
  });

  it('shrinks the inner border by borderGap on every side and returns the same bounds it drew', () => {
    const p = paper({ widthMm: 300, heightMm: 200 });
    const f = frame({
      border: {
        outerLineWeight: 0.7,
        innerLineWeight: 0.35,
        borderGap: 4,
        showFoldMarks: false,
        showTrimMarks: false,
      },
    });
    const result = renderFrame(p, f);
    const [, inner] = rects(result.svgElements);

    // innerX = 16+4=20, innerY = 5+4=9, innerW = 277-8=269, innerH = 184-8=176
    expect(inner).toEqual({ x: 20, y: 9, width: 269, height: 176 });
    // The returned innerBounds must be the SAME rectangle actually drawn —
    // two structures (drawn SVG, returned bounds) over one domain.
    expect(result.innerBounds).toEqual({ x: 20, y: 9, width: 269, height: 176 });
  });

  it('omits the inner border and reports the outer bounds as inner when borderGap is 0', () => {
    const p = paper({ widthMm: 300, heightMm: 200 });
    const f = frame({
      border: {
        outerLineWeight: 0.7,
        innerLineWeight: 0.35,
        borderGap: 0,
        showFoldMarks: false,
        showTrimMarks: false,
      },
    });
    const result = renderFrame(p, f);
    expect(rects(result.svgElements).length).toBe(1);
    expect(result.innerBounds).toEqual({ x: 16, y: 5, width: 277, height: 184 });
  });

  it('omits the inner border when innerLineWeight is 0, even with a nonzero gap', () => {
    const p = paper({ widthMm: 300, heightMm: 200 });
    const f = frame({
      border: {
        outerLineWeight: 0.7,
        innerLineWeight: 0,
        borderGap: 4,
        showFoldMarks: false,
        showTrimMarks: false,
      },
    });
    const result = renderFrame(p, f);
    expect(rects(result.svgElements).length).toBe(1);
  });
});

describe('renderFrame: zone references', () => {
  it('places each horizontal letter at the centre of its own zone and each vertical number likewise', () => {
    const p = paper({ widthMm: 300, heightMm: 200 });
    const f = frame({
      showZoneReferences: true,
      horizontalZones: 4,
      verticalZones: 3,
      zoneFontSize: 3.5,
      border: {
        outerLineWeight: 0.7,
        innerLineWeight: 0.35,
        borderGap: 4,
        showFoldMarks: false,
        showTrimMarks: false,
      },
    });
    const result = renderFrame(p, f);
    const svg = result.svgElements;

    // outerX=16, outerY=5, outerW=277, outerH=184 (from the bounds test above)
    const zoneWidth = 277 / 4;
    const zoneHeight = 184 / 3;

    for (let i = 0; i < 4; i++) {
      const letter = 'ABCD'[i];
      const x = (16 + zoneWidth * (i + 0.5)).toFixed(2);
      // top label
      expect(svg).toContain(`<text x="${x}" y="${(5 - 2).toFixed(2)}"`);
      expect(svg).toContain(`>${letter}</text>`);
    }
    for (let i = 0; i < 3; i++) {
      const number = String(i + 1);
      const y = (5 + zoneHeight * (i + 0.5)).toFixed(2);
      expect(svg).toContain(`y="${y}"`);
      expect(svg).toContain(`>${number}</text>`);
    }

    // Tick marks sit only BETWEEN zones (i > 0): 4 horizontal zones -> 3
    // top ticks and 3 bottom ticks; 3 vertical zones -> 2 left and 2 right.
    const topTickX = (16 + zoneWidth * 1).toFixed(2);
    expect(svg).toContain(`<line x1="${topTickX}" y1="5.00"`);
  });

  it('draws no zone group when horizontalZones is 0, even with showZoneReferences true', () => {
    const p = paper();
    const f = frame({ showZoneReferences: true, horizontalZones: 0, verticalZones: 5 });
    const result = renderFrame(p, f);
    expect(result.svgElements).not.toContain('zone-references');
  });
});

describe('renderFrame: fold marks (DIN 824)', () => {
  it('adds no fold marks on a sheet no larger than one A4 fold unit', () => {
    const p = paper({ widthMm: 200, heightMm: 280 }); // < 210 wide, < 297 tall
    const f = frame({
      border: {
        outerLineWeight: 0.7,
        innerLineWeight: 0.35,
        borderGap: 0,
        showFoldMarks: true,
        showTrimMarks: false,
      },
    });
    const result = renderFrame(p, f);
    // The fold-marks group is still emitted (empty), but no fold LINE is —
    // this is what "no fold marks" actually means for a reader of the SVG.
    expect(result.svgElements).not.toMatch(/<g id="fold-marks">\s*<line/);
  });

  it('adds vertical fold lines counted from the right edge when the sheet is wider than 210mm', () => {
    // width 500mm -> numVFolds = ceil(500/210) = 3, i = 1..2
    // x1 = 500 - 1*210 = 290 (>20, kept); x2 = 500 - 2*210 = 80 (>20, kept)
    const p = paper({ widthMm: 500, heightMm: 280 });
    const f = frame({
      border: {
        outerLineWeight: 0.7,
        innerLineWeight: 0.35,
        borderGap: 0,
        showFoldMarks: true,
        showTrimMarks: false,
      },
    });
    const result = renderFrame(p, f);
    expect(result.svgElements).toContain('fold-marks');
    expect(result.svgElements).toContain('<line x1="290.00" y1="0" x2="290.00" y2="5.00"');
    expect(result.svgElements).toContain('<line x1="80.00" y1="0" x2="80.00" y2="5.00"');
  });

  it('adds horizontal fold lines counted from the top when the sheet is taller than 297mm', () => {
    // height 650mm -> numHFolds = ceil(650/297) = 3, i = 1..2 -> y = 297, 594
    // both < 650-20=630 for the first (297<630 kept), second: 594<630 kept.
    const p = paper({ widthMm: 200, heightMm: 650 });
    const f = frame({
      border: {
        outerLineWeight: 0.7,
        innerLineWeight: 0.35,
        borderGap: 0,
        showFoldMarks: true,
        showTrimMarks: false,
      },
    });
    const result = renderFrame(p, f);
    expect(result.svgElements).toContain('<line x1="0" y1="297.00" x2="5.00" y2="297.00"');
    expect(result.svgElements).toContain('<line x1="0" y1="594.00" x2="5.00" y2="594.00"');
  });
});

describe('renderFrame: trim marks', () => {
  it('draws corner marks offset 3mm in from each of the four paper corners', () => {
    const p = paper({ widthMm: 300, heightMm: 200 });
    const f = frame({
      border: {
        outerLineWeight: 0.7,
        innerLineWeight: 0.35,
        borderGap: 0,
        showFoldMarks: false,
        showTrimMarks: true,
      },
    });
    const result = renderFrame(p, f);
    const svg = result.svgElements;
    expect(svg).toContain('trim-marks');
    // Top-left corner: vertical mark at x=3, horizontal mark at y=3.
    expect(svg).toContain('<line x1="3.00" y1="0" x2="3.00" y2="8.00"');
    // Bottom-right corner: offset from width (300-3=297) and height (200-3=197).
    expect(svg).toContain('<line x1="297.00" y1="192.00" x2="297.00" y2="200.00"');
  });
});
