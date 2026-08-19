/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `renderScaleBar`/`renderNorthArrow` are legacy SVG furniture (distinct from
 * the layout-maths `scale-stamp.ts` in the same folder — see that file for
 * the "is this really to scale" contract). Neither had a test.
 *
 * What is checked here:
 * - the paper-length maths (`totalLengthM * 1000 / scale.factor`) that every
 *   one of the four bar styles and the label placement must independently
 *   agree on — a distinct scale factor, division count and totalLengthM
 *   make a transposed or squared term visible.
 * - each of the FOUR bar styles (`alternating`, `linear`, `single`,
 *   `graphic`) plus the unknown-style fallback: five arms of one switch.
 * - the label-thinning rule (only first/middle/last division get a number)
 *   at both sides of its `primaryDivisions > 2` branch.
 * - each of the THREE north-arrow styles plus `'none'`.
 */

import { describe, expect, it } from 'vitest';
import { renderScaleBar, renderNorthArrow } from './scale-bar-renderer.js';
import type { ScaleBarConfig, NorthArrowConfig, ScaleBarStyle } from './scale-bar-types.js';
import type { DrawingScale } from '../styles.js';

function config(overrides: Partial<ScaleBarConfig> = {}): ScaleBarConfig {
  return {
    visible: true,
    style: 'alternating',
    position: 'below-viewport',
    units: 'metric',
    totalLengthM: 12, // distinct from primaryDivisions and scale factor
    primaryDivisions: 4,
    subdivisions: 1,
    heightMm: 3,
    labelFontSize: 2.5,
    showUnitLabel: true,
    fillColor: '#111111',
    strokeColor: '#222222',
    lineWeight: 0.3,
    ...overrides,
  };
}

const scale: DrawingScale = { name: '1:40', factor: 40, useCase: 'test' };

/** paperScale = 1000/40 = 25 mm per metre; barLengthMm = 12*25 = 300. */
const EXPECTED_BAR_LENGTH_MM = 300;

function rectsFilled(svg: string, fill: string): number {
  return (svg.match(new RegExp(`fill="${fill}"`, 'g')) ?? []).length;
}

describe('renderScaleBar: paper-scale maths shared by every style', () => {
  it('returns empty output when not visible, regardless of style', () => {
    expect(renderScaleBar(config({ visible: false }), scale, { x: 5, y: 8 })).toBe('');
  });

  it('sizes the alternating bar divisions from totalLengthM * (1000/scale.factor) / primaryDivisions', () => {
    const svg = renderScaleBar(config({ style: 'alternating' }), scale, { x: 5, y: 8 });
    // divisionLengthMm = 300 / 4 = 75mm; division 0 at x=5, division 1 at x=80.
    expect(svg).toContain('<rect x="5.00" y="8.00" width="75.00" height="3.00"');
    expect(svg).toContain('<rect x="80.00" y="8.00" width="75.00" height="3.00"');
    expect(svg).toContain('<rect x="155.00" y="8.00" width="75.00" height="3.00"');
    expect(svg).toContain('<rect x="230.00" y="8.00" width="75.00" height="3.00"');
    // Alternating fill: even index filled, odd white.
    expect(rectsFilled(svg, '#111111')).toBe(2); // divisions 0, 2
    expect(rectsFilled(svg, '#FFFFFF')).toBe(2); // divisions 1, 3
  });

  it('draws a linear bar as one full-length line plus a tick per division boundary', () => {
    const svg = renderScaleBar(config({ style: 'linear' }), scale, { x: 5, y: 8 });
    // Main line spans the full 300mm bar, vertically centred.
    expect(svg).toContain('<line x1="5.00" y1="9.50" x2="305.00" y2="9.50"');
    // primaryDivisions=4 -> 5 ticks at 0,75,150,225,300 (relative to x=5).
    for (const off of [0, 75, 150, 225, 300]) {
      expect(svg).toContain(`<line x1="${(5 + off).toFixed(2)}" y1="8.00" x2="${(5 + off).toFixed(2)}" y2="11.00"`);
    }
  });

  it('draws a single bar as one solid rect flanked by two end ticks', () => {
    const svg = renderScaleBar(config({ style: 'single' }), scale, { x: 5, y: 8 });
    expect(svg).toContain('<rect x="5.00" y="8.00" width="300.00" height="3.00"');
    // End ticks at x=5 and x=305, overshooting the bar by 1mm each way.
    expect(svg).toContain('<line x1="5.00" y1="7.00" x2="5.00" y2="12.00"');
    expect(svg).toContain('<line x1="305.00" y1="7.00" x2="305.00" y2="12.00"');
  });

  it('draws a graphic bar as an outer frame plus alternating solid/hatched divisions', () => {
    const svg = renderScaleBar(config({ style: 'graphic' }), scale, { x: 5, y: 8 });
    // Outer frame padded 0.5mm around the whole 300x3 bar.
    expect(svg).toContain('<rect x="4.50" y="7.50" width="301.00" height="4.00"');
    // Division 0 (even) is solid-filled with no stroke.
    expect(svg).toContain('<rect x="5.00" y="8.00" width="75.00" height="3.00" fill="#111111"/>');
    // Division 1 (odd) is a white hatched rect with 3 diagonal lines.
    expect(svg).toContain('<rect x="80.00" y="8.00" width="75.00" height="3.00" fill="#FFFFFF"');
  });

  it('falls back to the alternating style for a style value outside the union', () => {
    const bogus = 'zigzag' as unknown as ScaleBarStyle;
    const fallback = renderScaleBar(config({ style: bogus }), scale, { x: 5, y: 8 });
    const alternating = renderScaleBar(config({ style: 'alternating' }), scale, { x: 5, y: 8 });
    expect(fallback).toBe(alternating);
  });
});

describe('renderScaleBar: labels', () => {
  it('labels only 0 and the last division when primaryDivisions is 2 (no middle arm)', () => {
    const svg = renderScaleBar(config({ style: 'linear', primaryDivisions: 2, totalLengthM: 10 }), scale, { x: 0, y: 0 });
    // divisionValue = 10/2 = 5; last division (i=2) reads "10".
    expect(svg).toContain('>0</text>');
    expect(svg).toContain('>10</text>');
    // The would-be middle label (i=1, value "5") must NOT appear: only two
    // labels are drawn when there is no third division to distinguish it from.
    const numberLabels = [...svg.matchAll(/text-anchor="middle"[^>]*>(-?[\d.]+)<\/text>/g)].map((m) => m[1]);
    expect(numberLabels.sort()).toEqual(['0', '10']);
  });

  it('adds the middle division label once primaryDivisions exceeds 2', () => {
    const svg = renderScaleBar(config({ style: 'linear', primaryDivisions: 4, totalLengthM: 12 }), scale, { x: 0, y: 0 });
    // divisionValue = 12/4 = 3; middle division i=2 -> value 6 (<10, one
    // decimal: "6.0"); last i=4 -> value 12 (>=10, whole number: "12").
    const numberLabels = [...svg.matchAll(/text-anchor="middle"[^>]*>(-?[\d.]+)<\/text>/g)].map((m) => m[1]);
    expect(numberLabels.sort()).toEqual(['0', '12', '6.0']);
  });

  it('formats a division value under 10 with one decimal and 10-or-over as a whole number', () => {
    // primaryDivisions=3, totalLengthM=25 -> divisionValue=25/3=8.333...
    // middle (i=1) = 8.33... -> "8.3"; last (i=3) = 25 -> "25"
    const svg = renderScaleBar(config({ style: 'linear', primaryDivisions: 3, totalLengthM: 25 }), scale, { x: 0, y: 0 });
    expect(svg).toContain('>8.3</text>');
    expect(svg).toContain('>25</text>');
  });

  it('prints the imperial unit label as "ft" and metric as "m"', () => {
    const imperial = renderScaleBar(config({ units: 'imperial', showUnitLabel: true }), scale, { x: 0, y: 0 });
    const metric = renderScaleBar(config({ units: 'metric', showUnitLabel: true }), scale, { x: 0, y: 0 });
    expect(imperial).toMatch(/>ft<\/text>/);
    expect(metric).toMatch(/>m<\/text>/);
  });

  it('omits the unit label entirely when showUnitLabel is false', () => {
    const svg = renderScaleBar(config({ showUnitLabel: false }), scale, { x: 0, y: 0 });
    expect(svg).not.toMatch(/>m<\/text>/);
    expect(svg).not.toMatch(/>ft<\/text>/);
  });
});

describe('renderScaleBar: subdivisions', () => {
  it('draws exactly `subdivisions` sub-bars (subdivisions-1 in the loop, plus the zero marker) on the alternating style', () => {
    const svg = renderScaleBar(config({ style: 'alternating', subdivisions: 3 }), scale, { x: 5, y: 8 });
    // Sub-bars are the half-height rects at y = 8 - 3*0.5 = 6.5.
    const subRects = (svg.match(/y="6\.50"/g) ?? []).length;
    expect(subRects).toBe(3); // zero marker + 2 from the loop (j=1,2)
  });

  it('draws no sub-bars when subdivisions is 1', () => {
    const svg = renderScaleBar(config({ style: 'alternating', subdivisions: 1 }), scale, { x: 5, y: 8 });
    expect(svg).not.toContain('y="6.50"');
  });
});

describe('renderNorthArrow', () => {
  const base: NorthArrowConfig = {
    style: 'simple',
    rotation: 0,
    positionMm: { x: 40, y: 60 },
    sizeMm: 20,
  };

  it('renders nothing for style "none"', () => {
    expect(renderNorthArrow({ ...base, style: 'none' }, { x: 40, y: 60 })).toBe('');
  });

  it('translates and rotates the group to the given position and rotation', () => {
    const svg = renderNorthArrow({ ...base, rotation: 33 }, { x: 40, y: 60 });
    expect(svg).toContain('translate(40.00, 60.00) rotate(33)');
  });

  it('renders a simple arrow as one filled triangle plus an "N" label', () => {
    const svg = renderNorthArrow({ ...base, style: 'simple' }, { x: 0, y: 0 });
    expect(svg).toContain('<polygon points="0,-10 4,6 -4,6"');
    expect(svg).toContain('>N</text>');
    expect(svg).not.toContain('<circle');
  });

  it('renders a compass rose with a bounding circle and both filled and outline pointers', () => {
    const svg = renderNorthArrow({ ...base, style: 'compass' }, { x: 0, y: 0 });
    expect(svg).toContain('<circle cx="0" cy="0" r="10.00"');
    expect(svg).toContain('fill="#000000"/>'); // filled north pointer
    expect(svg).toContain('fill="none" stroke="#000000" stroke-width="0.3"/>\n'); // outline south pointer
  });

  it('renders a decorative arrow with an outer and inner circle plus a four-pointed star', () => {
    const svg = renderNorthArrow({ ...base, style: 'decorative' }, { x: 0, y: 0 });
    expect(svg).toContain('<circle cx="0" cy="0" r="10.00"');
    expect(svg).toContain('<circle cx="0" cy="0" r="3.00"'); // inner: halfSize*0.3
    expect(svg).toContain('<polygon points="0,-9.5 1.5,-1.5 9.5,0 1.5,1.5 0,9.5 -1.5,1.5 -9.5,0 -1.5,-1.5"');
  });
});
