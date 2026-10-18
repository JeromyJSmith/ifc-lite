/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';
import { Moon, Sun, Sparkles } from 'lucide-react';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';

/**
 * Dark mode switch for the ribbon.
 *
 * fix31 C5: this replaces the 80 px animated beautiful-theme-toggle widget, which was squeezed into the 32 px ribbon
 * row and read as "stuck between states". It is now a plain switch whose state always comes from the store:
 *  - `role="switch"` + `aria-checked` = dark mode on/off, and a visible "Dark on" / "Dark off" label
 *  - click → store.toggleTheme (dark ↔ light; colorful drops to dark, as before)
 *  - Shift+click → store.toggleColorful (the hidden "colorful" theme, as before)
 * Keyboard shortcut / command palette changes re-render it through the store subscription.
 */
export function ThemeSwitch() {
  const theme = useViewerStore((s) => s.theme);
  const isDark = theme === 'dark';
  const isColorful = theme === 'colorful';

  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const store = useViewerStore.getState();
    if (e.shiftKey) store.toggleColorful();
    else store.toggleTheme();
  }, []);

  const Icon = isColorful ? Sparkles : isDark ? Moon : Sun;
  const label = isColorful ? 'Colorful' : isDark ? 'Dark on' : 'Dark off';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={`Dark mode ${isDark ? 'on' : 'off'}`}
      data-testid="theme-switch"
      data-theme-state={theme}
      onClick={handleClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs font-medium whitespace-nowrap transition-colors',
        isDark
          ? 'border-sky-500/60 bg-sky-500/15 text-sky-300'
          : isColorful
            ? 'border-fuchsia-400/60 bg-fuchsia-400/15 text-fuchsia-600'
            : 'border-border bg-background text-muted-foreground hover:bg-muted',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
          isDark ? 'bg-sky-500' : 'bg-muted-foreground/30',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform',
            isDark ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </span>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}
