/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { WindowSymbolGenerator, generateSimpleWindowLines } from './window-symbol.js';
import type { WindowFrameParameters, OpeningInfo, Bounds2D, WindowPartitioningType } from '../types.js';

function expectPointCloseTo(actual: { x: number; y: number }, expected: { x: number; y: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
}

// wallDir is a unit vector along (3, 4); perpDir is wallDir rotated +90 degrees (CCW),
// matching WindowSymbolGenerator.getPerpendicularDirection's convention. Both components
// of both vectors are non-zero and distinct, and center/width/thickness are all non-zero
// and distinct, so a swapped x/y basis, a swapped frame/jamb pairing, or a sign flip on
// only one axis cannot hide behind a coincidental zero component.
const wallDir = { x: 0.6, y: 0.8 };
const perpDir = { x: -0.8, y: 0.6 };
const center = { x: 7, y: 3 };

describe('WindowSymbolGenerator.generateSymbol: full geometry, non-axis-aligned fixture', () => {
  const generator = new WindowSymbolGenerator();
  const width = 4;
  const wallThickness = 1;

  it('places outer frame, inner frame, jambs, and glass line at the expected coordinates', () => {
    const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, 'SINGLE_PANEL');

    // outer frame line: at +perpDir face
    expectPointCloseTo(result.lines[0].start, { x: 5.4, y: 1.7 });
    expectPointCloseTo(result.lines[0].end, { x: 7.8, y: 4.9 });

    // inner frame line: at -perpDir face
    expectPointCloseTo(result.lines[1].start, { x: 6.2, y: 1.1 });
    expectPointCloseTo(result.lines[1].end, { x: 8.6, y: 4.3 });

    // jamb at the -wallDir (start) side connects outer.start to inner.start
    expectPointCloseTo(result.lines[2].start, { x: 5.4, y: 1.7 });
    expectPointCloseTo(result.lines[2].end, { x: 6.2, y: 1.1 });

    // jamb at the +wallDir (end) side connects outer.end to inner.end
    expectPointCloseTo(result.lines[3].start, { x: 7.8, y: 4.9 });
    expectPointCloseTo(result.lines[3].end, { x: 8.6, y: 4.3 });

    // glass line: centered between the two faces, spanning the opening width
    expectPointCloseTo(result.lines[4].start, { x: 5.8, y: 1.4 });
    expectPointCloseTo(result.lines[4].end, { x: 8.2, y: 4.6 });

    expect(result.lines.length).toBe(5); // SINGLE_PANEL adds no mullions
  });

  it('reports symbol metadata (type, position, rotation, scale) for the same fixture', () => {
    const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, 'SINGLE_PANEL');
    expect(result.symbol.type).toBe('window-frame');
    expectPointCloseTo(result.symbol.position, center);
    expect(result.symbol.rotation).toBeCloseTo(Math.atan2(0.8, 0.6), 9);
    expect(result.symbol.scale).toBe(1);
  });

  it('reports width and mullionCount=0 for SINGLE_PANEL in the parameters', () => {
    const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, 'SINGLE_PANEL');
    const params = result.symbol.parameters as WindowFrameParameters;
    expect(params.width).toBe(4);
    expect(params.mullionCount).toBe(0);
  });
});

describe('WindowSymbolGenerator.generateSymbol: frameDepth is linear in wallThickness, not squared', () => {
  const generator = new WindowSymbolGenerator({ frameDepthRatio: 0.25 });

  it('frameDepth = wallThickness * frameDepthRatio at wallThickness=2 (a squared or halved term would diverge here)', () => {
    const result = generator.generateSymbol(center, 4, 2, wallDir, perpDir, 'SINGLE_PANEL');
    const params = result.symbol.parameters as WindowFrameParameters;
    // Linear: 2 * 0.25 = 0.5. Squared-thickness bug: 2^2 * 0.25 = 1. Squared-ratio bug: 2 * 0.0625 = 0.125.
    expect(params.frameDepth).toBeCloseTo(0.5, 9);
  });
});

describe('WindowSymbolGenerator.generateSymbol: config toggles gate individual line groups', () => {
  const width = 4;
  const wallThickness = 1;

  it('showFrameLines=false suppresses frame and jamb lines but keeps the glass line', () => {
    const generator = new WindowSymbolGenerator({ showFrameLines: false, showGlassLine: true });
    const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, 'SINGLE_PANEL');
    expect(result.lines.length).toBe(1);
    expectPointCloseTo(result.lines[0].start, { x: 5.8, y: 1.4 });
    expectPointCloseTo(result.lines[0].end, { x: 8.2, y: 4.6 });
  });

  it('showGlassLine=false suppresses the glass line but keeps the frame and jamb lines', () => {
    const generator = new WindowSymbolGenerator({ showFrameLines: true, showGlassLine: false });
    const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, 'SINGLE_PANEL');
    expect(result.lines.length).toBe(4);
  });

  it('both toggles false yields no frame/glass lines at all (mullions only)', () => {
    const generator = new WindowSymbolGenerator({ showFrameLines: false, showGlassLine: false });
    const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, 'DOUBLE_PANEL_VERTICAL');
    expect(result.lines.length).toBe(1); // just the vertical mullion
  });
});

describe('WindowSymbolGenerator: mullion geometry per partitioning arm', () => {
  // width=6 and wallThickness=1 give clean thirdWidth math (thirdWidth/2 = 1) so expected
  // coordinates are exact rather than repeating decimals.
  const generator = new WindowSymbolGenerator();
  const width = 6;
  const wallThickness = 1;

  it('DOUBLE_PANEL_VERTICAL: exactly one mullion, centered on the window, spanning wall thickness', () => {
    const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, 'DOUBLE_PANEL_VERTICAL');
    const mullions = result.lines.slice(5);
    expect(mullions.length).toBe(1);
    expectPointCloseTo(mullions[0].start, { x: 6.6, y: 3.3 });
    expectPointCloseTo(mullions[0].end, { x: 7.4, y: 2.7 });
    const params = result.symbol.parameters as WindowFrameParameters;
    expect(params.mullionCount).toBe(1);
  });

  it('TRIPLE_PANEL_VERTICAL: two mullions at +-width/6 from center, each spanning wall thickness', () => {
    const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, 'TRIPLE_PANEL_VERTICAL');
    const mullions = result.lines.slice(5);
    expect(mullions.length).toBe(2);
    expectPointCloseTo(mullions[0].start, { x: 6.0, y: 2.5 });
    expectPointCloseTo(mullions[0].end, { x: 6.8, y: 1.9 });
    expectPointCloseTo(mullions[1].start, { x: 7.2, y: 4.1 });
    expectPointCloseTo(mullions[1].end, { x: 8.0, y: 3.5 });
    const params = result.symbol.parameters as WindowFrameParameters;
    expect(params.mullionCount).toBe(2);
  });

  it('SINGLE_PANEL, USERDEFINED, and NOTDEFINED draw no mullions and report mullionCount=0', () => {
    for (const partitioning of ['SINGLE_PANEL', 'USERDEFINED', 'NOTDEFINED'] as const) {
      const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, partitioning);
      expect(result.lines.slice(5).length).toBe(0);
      const params = result.symbol.parameters as WindowFrameParameters;
      expect(params.mullionCount).toBe(0);
    }
  });
});

describe('SURPRISING: mullionCount disagrees with the mullion lines actually drawn for several partitioning types', () => {
  // getMullionCount() and generateMullions() are two independent switches over the same
  // WindowPartitioningType, and they have drifted apart. This is pinned as observed
  // behavior, not endorsed as correct -- flagged for the maintainer to decide whether the
  // geometry or the metadata is the one that's wrong.
  const generator = new WindowSymbolGenerator();
  const width = 6;
  const wallThickness = 1;

  it('DOUBLE_PANEL_HORIZONTAL: mullionCount reports 1 but zero mullion lines are drawn (case body is empty)', () => {
    const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, 'DOUBLE_PANEL_HORIZONTAL');
    expect(result.lines.slice(5).length).toBe(0);
    const params = result.symbol.parameters as WindowFrameParameters;
    expect(params.mullionCount).toBe(1);
  });

  it.each(['TRIPLE_PANEL_HORIZONTAL', 'TRIPLE_PANEL_LEFT', 'TRIPLE_PANEL_RIGHT'] as const)(
    '%s: mullionCount reports 2 but zero mullion lines are drawn (no case in generateMullions -> falls to default)',
    (partitioning) => {
      const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, partitioning);
      expect(result.lines.slice(5).length).toBe(0);
      const params = result.symbol.parameters as WindowFrameParameters;
      expect(params.mullionCount).toBe(2);
    }
  );

  it.each(['TRIPLE_PANEL_BOTTOM', 'TRIPLE_PANEL_TOP'] as const)(
    '%s: mullionCount reports 2 but only ONE mullion line is drawn, identical to DOUBLE_PANEL_VERTICAL',
    (partitioning) => {
      const result = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, partitioning);
      const mullions = result.lines.slice(5);
      expect(mullions.length).toBe(1);
      expectPointCloseTo(mullions[0].start, { x: 6.6, y: 3.3 });
      expectPointCloseTo(mullions[0].end, { x: 7.4, y: 2.7 });
      const params = result.symbol.parameters as WindowFrameParameters;
      expect(params.mullionCount).toBe(2);
    }
  );
});

describe('WindowSymbolGenerator.generateFromOpening', () => {
  const generator = new WindowSymbolGenerator();

  function makeOpening(overrides: Partial<OpeningInfo> = {}): OpeningInfo {
    return {
      type: 'window',
      openingId: 1,
      hostElementId: 2,
      width: 4,
      height: 2,
      bounds3D: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 2, z: 2 } },
      modelIndex: 0,
      ...overrides,
    };
  }

  it('derives center from the bounds midpoint and perpDirection from getPerpendicularDirection(wallDirection)', () => {
    const bounds2D: Bounds2D = { min: { x: 5, y: 1 }, max: { x: 9, y: 5 } };
    const opening = makeOpening({ width: 4 });
    const result = generator.generateFromOpening(opening, bounds2D, wallDir);

    // bounds midpoint = (7, 3), matching the shared `center` fixture above.
    expectPointCloseTo(result.symbol.position, center);
    // The outer frame line's offset comes entirely from perpDirection, so it is the line
    // that actually distinguishes a correct getPerpendicularDirection from a sign-flipped
    // or swapped one (the glass line does not depend on perpDirection at all).
    // wallThickness here is the generator's default (0.2), so halfThickness = 0.1:
    // outer.start = center - wallDir*halfWidth + perpDir*halfThickness
    //             = (7 - 1.2 - 0.08, 3 - 1.6 + 0.06) = (5.72, 1.46)
    expectPointCloseTo(result.lines[0].start, { x: 5.72, y: 1.46 });
    expectPointCloseTo(result.lines[0].end, { x: 8.12, y: 4.66 });
  });

  it('falls back to config.defaultWallThickness when no wallThickness is passed', () => {
    const localGenerator = new WindowSymbolGenerator({ defaultWallThickness: 3 });
    const bounds2D: Bounds2D = { min: { x: 5, y: 1 }, max: { x: 9, y: 5 } };
    const opening = makeOpening({ width: 4 });
    const result = localGenerator.generateFromOpening(opening, bounds2D, wallDir);
    const params = result.symbol.parameters as WindowFrameParameters;
    // frameDepth = wallThickness * frameDepthRatio(0.1) = 3 * 0.1 = 0.3
    expect(params.frameDepth).toBeCloseTo(0.3, 9);
  });

  it('uses the explicit wallThickness argument over config.defaultWallThickness when provided', () => {
    const localGenerator = new WindowSymbolGenerator({ defaultWallThickness: 3 });
    const bounds2D: Bounds2D = { min: { x: 5, y: 1 }, max: { x: 9, y: 5 } };
    const opening = makeOpening({ width: 4 });
    const result = localGenerator.generateFromOpening(opening, bounds2D, wallDir, 5);
    const params = result.symbol.parameters as WindowFrameParameters;
    expect(params.frameDepth).toBeCloseTo(0.5, 9); // 5 * 0.1, not 3 * 0.1
  });

  it('defaults to SINGLE_PANEL (mullionCount=0) when windowPartitioning is undefined', () => {
    const bounds2D: Bounds2D = { min: { x: 5, y: 1 }, max: { x: 9, y: 5 } };
    const opening = makeOpening({ width: 4, windowPartitioning: undefined });
    const result = generator.generateFromOpening(opening, bounds2D, wallDir);
    const params = result.symbol.parameters as WindowFrameParameters;
    expect(params.mullionCount).toBe(0);
  });

  it('honors an explicit windowPartitioning from the opening', () => {
    const bounds2D: Bounds2D = { min: { x: 4, y: 0 }, max: { x: 10, y: 6 } };
    const opening = makeOpening({ width: 6, windowPartitioning: 'DOUBLE_PANEL_VERTICAL' as WindowPartitioningType });
    const result = generator.generateFromOpening(opening, bounds2D, wallDir);
    const params = result.symbol.parameters as WindowFrameParameters;
    expect(params.mullionCount).toBe(1);
    expect(result.lines.length).toBe(6); // 4 frame/jamb + glass + 1 mullion
  });
});

describe('generateSimpleWindowLines', () => {
  it('matches WindowSymbolGenerator.generateSymbol(SINGLE_PANEL) with the same perpDirection convention', () => {
    const width = 4;
    const wallThickness = 0.75;
    const direct = generateSimpleWindowLines(center, width, wallDir, wallThickness);

    const generator = new WindowSymbolGenerator();
    const viaClass = generator.generateSymbol(center, width, wallThickness, wallDir, perpDir, 'SINGLE_PANEL');

    expect(direct.length).toBe(viaClass.lines.length);
    for (let i = 0; i < direct.length; i++) {
      expectPointCloseTo(direct[i].start, viaClass.lines[i].start);
      expectPointCloseTo(direct[i].end, viaClass.lines[i].end);
    }
  });

  it('defaults wallThickness to 0.2 when omitted', () => {
    const lines = generateSimpleWindowLines(center, 4, wallDir);
    // outer frame line offset by perpDir * (0.2/2) = perpDir * 0.1
    const expectedStart = {
      x: center.x - wallDir.x * 2 + perpDir.x * 0.1,
      y: center.y - wallDir.y * 2 + perpDir.y * 0.1,
    };
    expectPointCloseTo(lines[0].start, expectedStart);
  });
});
