/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Layer-panel row: "Splat (Gaussian)" on/off plus overlay opacity. Off by default. */

import { useSyncExternalStore } from 'react';
import {
  getGaussianSplatState,
  setGaussianSplatEnabled,
  setGaussianSplatOpacity,
  setGaussianSplatSpec,
  subscribeGaussianSplat,
} from './gaussianSplatOverlay';

export function GaussianSplatToggle() {
  const s = useSyncExternalStore(subscribeGaussianSplat, getGaussianSplatState);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-card/50 px-2 py-1.5 text-2xs" data-testid="gaussian-splat-toggle">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={(e) => void setGaussianSplatEnabled(e.target.checked)}
          aria-label="Splat (Gaussian)"
        />
        <span className="flex-1 font-medium">3DGS Reality Splat (Spark)</span>
        <span className={s.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{s.message}</span>
      </label>
      {s.specs.length > 1 && (
        <select
          value={s.spec?.id ?? s.specs[0]?.id ?? ''}
          onChange={(e) => void setGaussianSplatSpec(e.target.value)}
          className="w-full rounded border bg-background px-1.5 py-0.5 text-2xs text-foreground"
          aria-label="Select Gaussian Splat Zone"
        >
          {s.specs.map((spec) => (
            <option key={spec.id} value={spec.id}>
              {spec.name}
            </option>
          ))}
        </select>
      )}
      {s.enabled && (
        <label className="flex items-center gap-2 text-muted-foreground">
          Opacity
          <input
            type="range" min={0.1} max={1} step={0.05} value={s.opacity}
            onChange={(e) => setGaussianSplatOpacity(Number(e.target.value))}
            className="flex-1"
          />
        </label>
      )}
    </div>
  );
}
