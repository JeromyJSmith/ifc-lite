/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/. */
import { createContext, type Context } from 'react';
/** Vite keeps this module-local data object across hot replacements. */
export function createHotContext<T>(initial: T, data?: { context?: Context<T> }): Context<T> {
  if (!data) return createContext(initial);
  return data.context ??= createContext(initial);
}
