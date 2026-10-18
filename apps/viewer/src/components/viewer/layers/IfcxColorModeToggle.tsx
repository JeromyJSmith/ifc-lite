/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Layer-panel row: colour by Material (the file's own colours, default) or by Layer (the winning layer's colour). */

import { useEffect, useSyncExternalStore } from 'react';
import { useViewerStore } from '@/store';
import { getIfcxColorModeState, setIfcxColorMode, subscribeIfcxColorMode, type IfcxColorMode } from './ifcxColorMode';

const MODE_LABELS: ReadonlyArray<{ mode: IfcxColorMode; label: string; title: string }> = [
  { mode: 'delineate', label: 'Delineate', title: 'Vivid distinct colours per wall section, stair flight, baluster, roof slope, and opening' },
  { mode: 'zone', label: 'Zone', title: 'Colour by Apartment / Storey / Circulation Zone' },
  { mode: 'material', label: 'Material', title: 'Original IFCX material / surface style colours' },
  { mode: 'layer', label: 'Layer', title: 'Colour by winning IFCX overlay layer' },
];

export function IfcxColorModeToggle() {
  const s = useSyncExternalStore(subscribeIfcxColorMode, getIfcxColorModeState);
  const modelCount = useViewerStore((state) => state.models.size);

  useEffect(() => {
    if (s.count === 0 && modelCount > 0) {
      setIfcxColorMode(s.mode);
    }
  }, [s.count, s.mode, modelCount]);

  if (s.count === 0 && modelCount === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border bg-card/50 px-2 py-1.5 text-2xs" data-testid="ifcx-color-mode">
      <span className="mr-1 font-semibold uppercase tracking-wider text-muted-foreground">Colour</span>
      {MODE_LABELS.map(({ mode, label, title }) => (
        <button
          key={mode}
          type="button"
          title={title}
          aria-pressed={s.mode === mode}
          onClick={() => setIfcxColorMode(mode)}
          className={`rounded px-2 py-0.5 font-medium transition-colors ${
            s.mode === mode
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
