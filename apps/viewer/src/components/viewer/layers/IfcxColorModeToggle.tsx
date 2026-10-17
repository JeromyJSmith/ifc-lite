/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Layer-panel row: colour by Material (the file's own colours, default) or by Layer (the winning layer's colour). */

import { useSyncExternalStore } from 'react';
import { getIfcxColorModeState, setIfcxColorMode, subscribeIfcxColorMode } from './ifcxColorMode';

export function IfcxColorModeToggle() {
  const s = useSyncExternalStore(subscribeIfcxColorMode, getIfcxColorModeState);
  if (s.count === 0) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border bg-card/50 px-2 py-1.5 text-2xs" data-testid="ifcx-color-mode">
      <span className="flex-1 font-medium">Colour</span>
      {(['material', 'layer'] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={s.mode === m}
          onClick={() => setIfcxColorMode(m)}
          className={`rounded px-2 py-0.5 ${s.mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
        >
          {m === 'material' ? 'Material' : 'Layer'}
        </button>
      ))}
    </div>
  );
}
