// SPDX-License-Identifier: AGPL-3.0-only
// The instrument's own settings: how it looks and how heavily it draws, for
// this operator, in this browser. Nothing here is a property of the part on
// screen or saved with a project — the same rule the navigation scheme and
// the colour scheme follow, which live in the main store because they predate
// this file and the scene reads them from there. The settings dialog shows
// all of them together.
//
// Each setting is remembered under a key of its own and falls back to the
// default when storage is unavailable (private mode, blocked cookies) or holds
// something this version cannot read.

import { create } from 'zustand'
import {
  SECTION_LINE_DEFAULT,
  SHEET_LINE_DEFAULT,
  clampLineWidth,
} from '../viewer/lineWidths'

/** Light or dark chassis, or whichever the operating system is set to. */
export type UiTheme = 'light' | 'dark' | 'system'

export const UI_THEMES: { id: UiTheme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

const UI_THEME_KEY = 'scanruler.uitheme'
const SECTION_LINES_KEY = 'scanruler.sectionlines'
const SHEET_LINES_KEY = 'scanruler.sheetlines'

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Not being able to remember the choice is no reason to refuse it — the
    // setting still holds for this session.
  }
}

const storedUiTheme = (): UiTheme => {
  const v = read(UI_THEME_KEY)
  return v === 'dark' || v === 'system' ? v : 'light'
}

/** The operating system's preference, watched so that "System" follows it
 *  live rather than at the next reload. Absent outside a browser. */
const systemDark =
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

const resolveDark = (theme: UiTheme): boolean =>
  theme === 'dark' || (theme === 'system' && Boolean(systemDark?.matches))

interface PrefsState {
  uiTheme: UiTheme
  /** What the theme comes to right now — the one thing the stylesheet and
   *  the scenes actually read. Derived, never set directly. */
  dark: boolean
  /** Section cuts on the part in 3D, in pixels. */
  sectionLines: number
  /** Fitted curves over a flatbed scan in 2D Measure, in pixels. */
  sheetLines: number
  settingsOpen: boolean
  setUiTheme: (theme: UiTheme) => void
  setSectionLines: (px: number) => void
  setSheetLines: (px: number) => void
  openSettings: (open: boolean) => void
}

export const usePrefs = create<PrefsState>()((set) => {
  const uiTheme = storedUiTheme()
  return {
    uiTheme,
    dark: resolveDark(uiTheme),
    sectionLines: clampLineWidth(read(SECTION_LINES_KEY), SECTION_LINE_DEFAULT),
    sheetLines: clampLineWidth(read(SHEET_LINES_KEY), SHEET_LINE_DEFAULT),
    settingsOpen: false,

    setUiTheme: (theme) => {
      write(UI_THEME_KEY, theme)
      set({ uiTheme: theme, dark: resolveDark(theme) })
    },
    setSectionLines: (px) => {
      const sectionLines = clampLineWidth(px, SECTION_LINE_DEFAULT)
      write(SECTION_LINES_KEY, String(sectionLines))
      set({ sectionLines })
    },
    setSheetLines: (px) => {
      const sheetLines = clampLineWidth(px, SHEET_LINE_DEFAULT)
      write(SHEET_LINES_KEY, String(sheetLines))
      set({ sheetLines })
    },
    openSettings: (settingsOpen) => set({ settingsOpen }),
  }
})

// The stylesheet reads the theme off the root element — `data-theme` is what
// its dark tokens key on. index.html sets the same attribute before the first
// paint from the same storage key, so a dark instrument never flashes light;
// from here on this keeps it true for the life of the page.
const applyDark = (dark: boolean): void => {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}
applyDark(usePrefs.getState().dark)
usePrefs.subscribe((s, prev) => {
  if (s.dark !== prev.dark) applyDark(s.dark)
})
systemDark?.addEventListener('change', () => {
  const s = usePrefs.getState()
  if (s.uiTheme === 'system') usePrefs.setState({ dark: resolveDark('system') })
})
