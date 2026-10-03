// SPDX-License-Identifier: AGPL-3.0-only
// The instrument's own settings: how it looks and how heavily it draws, for
// this operator, in this browser. Nothing here is a property of the part on
// screen or saved with a project — the same rule the navigation scheme and
// the colour scheme follow, which live in the main store because they predate
// this file and the scene reads them from there. The settings dialog shows
// the instrument-wide ones together; a setting that belongs to one control
// sits by that control, the way the pin switch sits by the pinned readings.
//
// Each setting is remembered under a key of its own and falls back to the
// default when storage is unavailable (private mode, blocked cookies) or holds
// something this version cannot read.

import { create } from 'zustand'
import { colormapById, type ColormapId } from '../core/field/colormap'
import { meshUnitsOf, type MeshUnits } from '../core/meshUnits'
import {
  EDGE_LINE_DEFAULT,
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
const COLORMAP_KEY = 'scanruler.colormap'
const SECTION_LINES_KEY = 'scanruler.sectionlines'
const SHEET_LINES_KEY = 'scanruler.sheetlines'
const EDGE_LINES_KEY = 'scanruler.edgelines'
const PINS_BEHIND_KEY = 'scanruler.pinsbehind'
const SUPPORT_CARD_KEY = 'scanruler.supportcard'
const STL_UNITS_KEY = 'scanruler.stlunits'
const ASK_STL_UNITS_KEY = 'scanruler.askstlunits'

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

/** System unless told otherwise: an instrument that comes up in the chassis
 *  the rest of the desktop wears. index.html reads the same key the same way
 *  for the first paint. */
const storedUiTheme = (): UiTheme => {
  const v = read(UI_THEME_KEY)
  return v === 'dark' || v === 'light' ? v : 'system'
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
  /** The ramp every map on the part is painted in, and every legend beside
   *  one drawn in. Jet until another is chosen. */
  colormap: ColormapId
  /** Section cuts on the part in 3D, in pixels. */
  sectionLines: number
  /** Fitted curves over a flatbed scan in 2D Measure, in pixels. */
  sheetLines: number
  /** The edge chains the curves are fitted to — found in the scan, or cut by
   *  a section — in pixels. */
  edgeLines: number
  /** Pinned readings whose spot is on the far side of the part, or behind a
   *  feature of it, put away until the part turns to show them — the
   *  default; off, every pin shows through the part. */
  hidePinsBehind: boolean
  /** Whether the support card comes up in the corner of the stage on each
   *  visit. On by default; its own × puts it away for the page load only,
   *  this puts it away for good. */
  supportCard: boolean
  /** Whether opening an STL asks what units its coordinates are in — the
   *  format carries none. On by default; the question's "Don't ask again"
   *  switches it off, and the settings window switches it back on. */
  askStlUnits: boolean
  /** The units an STL is taken to be in when the question is off, and the
   *  answer the question offers first: the last one given. */
  stlUnits: MeshUnits
  settingsOpen: boolean
  setUiTheme: (theme: UiTheme) => void
  setColormap: (id: ColormapId) => void
  setSectionLines: (px: number) => void
  setSheetLines: (px: number) => void
  setEdgeLines: (px: number) => void
  setHidePinsBehind: (on: boolean) => void
  setSupportCard: (on: boolean) => void
  setAskStlUnits: (on: boolean) => void
  setStlUnits: (units: MeshUnits) => void
  openSettings: (open: boolean) => void
}

export const usePrefs = create<PrefsState>()((set) => {
  const uiTheme = storedUiTheme()
  return {
    uiTheme,
    dark: resolveDark(uiTheme),
    colormap: colormapById(read(COLORMAP_KEY)).id,
    sectionLines: clampLineWidth(read(SECTION_LINES_KEY), SECTION_LINE_DEFAULT),
    sheetLines: clampLineWidth(read(SHEET_LINES_KEY), SHEET_LINE_DEFAULT),
    edgeLines: clampLineWidth(read(EDGE_LINES_KEY), EDGE_LINE_DEFAULT),
    hidePinsBehind: read(PINS_BEHIND_KEY) !== '0',
    supportCard: read(SUPPORT_CARD_KEY) !== '0',
    askStlUnits: read(ASK_STL_UNITS_KEY) !== '0',
    stlUnits: meshUnitsOf(read(STL_UNITS_KEY)) ?? 'mm',
    settingsOpen: false,

    setUiTheme: (theme) => {
      write(UI_THEME_KEY, theme)
      set({ uiTheme: theme, dark: resolveDark(theme) })
    },
    setColormap: (id) => {
      const colormap = colormapById(id).id
      write(COLORMAP_KEY, colormap)
      set({ colormap })
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
    setEdgeLines: (px) => {
      const edgeLines = clampLineWidth(px, EDGE_LINE_DEFAULT)
      write(EDGE_LINES_KEY, String(edgeLines))
      set({ edgeLines })
    },
    setHidePinsBehind: (hidePinsBehind) => {
      write(PINS_BEHIND_KEY, hidePinsBehind ? '1' : '0')
      set({ hidePinsBehind })
    },
    setSupportCard: (supportCard) => {
      write(SUPPORT_CARD_KEY, supportCard ? '1' : '0')
      set({ supportCard })
    },
    setAskStlUnits: (askStlUnits) => {
      write(ASK_STL_UNITS_KEY, askStlUnits ? '1' : '0')
      set({ askStlUnits })
    },
    setStlUnits: (units) => {
      const stlUnits = meshUnitsOf(units) ?? 'mm'
      write(STL_UNITS_KEY, stlUnits)
      set({ stlUnits })
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
