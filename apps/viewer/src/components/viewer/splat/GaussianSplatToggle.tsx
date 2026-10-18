/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Layer-panel row: "Splat (Gaussian)" on/off plus overlay opacity. Off by default. */

import { useSyncExternalStore } from 'react';
import { useViewerStore } from '@/store';
import {
  getGaussianSplatState,
  setGaussianSplatEnabled,
  setGaussianSplatOpacity,
  subscribeGaussianSplat,
} from './gaussianSplatOverlay';

export function GaussianSplatToggle() {
  const s = useSyncExternalStore(subscribeGaussianSplat, getGaussianSplatState);
  const models = useViewerStore((state) => state.models);
  const setModelVisibility = useViewerStore((state) => state.setModelVisibility);

  const scanModels: Array<{ id: string; name: string; visible: boolean }> = [];
  const contextModels: Array<{ id: string; name: string; visible: boolean }> = [];
  for (const [id, m] of models.entries()) {
    const mExt = m as typeof m & { _isOverlay?: boolean };
    if (mExt._isOverlay || id.startsWith('layer')) continue;
    const lowerName = (m.name || '').toLowerCase();
    const isScan =
      m.schemaVersion === 'PointCloud' ||
      lowerName.includes('point cloud') ||
      lowerName.includes('lidar') ||
      lowerName.includes('laz') ||
      lowerName.includes('splat');
    if (isScan) {
      scanModels.push({ id, name: m.name, visible: m.visible });
    } else if (!lowerName.includes('00-base') && !lowerName.includes('401-pearl')) {
      contextModels.push({ id, name: m.name, visible: m.visible });
    }
  }

  const anyScanVisible = s.enabled || scanModels.some((m) => m.visible);

  const hideAllScansAndSplats = () => {
    if (s.enabled) void setGaussianSplatEnabled(false);
    for (const scan of scanModels) {
      if (scan.visible) setModelVisibility(scan.id, false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-card/50 px-2 py-1.5 text-2xs" data-testid="gaussian-splat-toggle">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">Scans &amp; Point Clouds</span>
        {anyScanVisible && (
          <button
            type="button"
            onClick={hideAllScansAndSplats}
            className="rounded bg-destructive/15 px-1.5 py-0.5 font-medium text-destructive hover:bg-destructive/25"
            title="Turn off both the Gaussian Splat (.spz) and all Point Cloud (.laz) layers"
          >
            Hide All Clouds
          </button>
        )}
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={(e) => void setGaussianSplatEnabled(e.target.checked)}
          aria-label="Splat (Gaussian)"
        />
        <span className="flex-1 font-medium">Drone Splat (.spz Gaussian)</span>
        <span className={s.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
          {s.message || (s.enabled ? 'ON' : 'OFF')}
        </span>
      </label>
      {s.enabled && (
        <label className="flex items-center gap-2 pl-4 text-muted-foreground">
          Opacity
          <input
            type="range" min={0.1} max={1} step={0.05} value={s.opacity}
            onChange={(e) => setGaussianSplatOpacity(Number(e.target.value))}
            className="flex-1"
          />
        </label>
      )}
      {scanModels.map((scan) => (
        <label key={scan.id} className="flex items-center gap-2 cursor-pointer" data-testid={`pointcloud-toggle-${scan.id}`}>
          <input
            type="checkbox"
            checked={scan.visible}
            onChange={(e) => setModelVisibility(scan.id, e.target.checked)}
            aria-label={scan.name}
          />
          <span className="flex-1 font-medium truncate" title={scan.name}>
            {scan.name.includes('f003') ? 'Drone Point Cloud (.laz centres)' : scan.name}
          </span>
          <span className="text-muted-foreground">{scan.visible ? 'ON' : 'OFF'}</span>
        </label>
      ))}
      {contextModels.map((ctx) => (
        <label key={ctx.id} className="flex items-center gap-2 cursor-pointer border-t border-border/50 pt-1">
          <input
            type="checkbox"
            checked={ctx.visible}
            onChange={(e) => setModelVisibility(ctx.id, e.target.checked)}
            aria-label={ctx.name}
          />
          <span className="flex-1 font-medium truncate" title={ctx.name}>
            Context: {ctx.name}
          </span>
          <span className="text-muted-foreground">{ctx.visible ? 'ON' : 'OFF'}</span>
        </label>
      ))}
    </div>
  );
}
