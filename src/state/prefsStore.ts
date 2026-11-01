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
import { displayUnitsOf, type DisplayUnits } from '../core/units'
import {
  EDGE_LINE_DEFAULT,
  SECTION_LINE_DEFAULT,
  SHEET_LINE_DEFAULT,
  clampLineWidth,
} from '../viewer/lineWidths'
import {
  spaceMouseAttached,
  spaceMouseReverseOf,
  spaceMouseSpeedOf,
  tuneSpaceMouse,
  watchSpaceMouse,
  type SpaceMouseAxisId,
} from '../viewer/spaceMouse'

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
const SUPPORT_ASK_KEY = 'scanruler.supportask'
const SUPPORT_ASK_OFF_UNTIL_KEY = 'scanruler.supportask.offuntil'
const UNITS_KEY = 'scanruler.units'
const STL_UNITS_KEY = 'scanruler.stlunits'
const ASK_STL_UNITS_KEY = 'scanruler.askstlunits'
const AGENT_LINK_KEY = 'scanruler.agentlink'
const AGENT_DATA_OK_KEY = 'scanruler.agentdataok'
const AGENT_PORT_KEY = 'scanruler.agentport'
const AGENT_TOKEN_KEY = 'scanruler.agenttoken'
const SPACE_MOUSE_SPEED_KEY = 'scanruler.spacemouse.speed'
const SPACE_MOUSE_REVERSE_KEY = 'scanruler.spacemouse.reverse'
const SPACE_MOUSE_SEEN_KEY = 'scanruler.spacemouse.seen'

/** The port the agent's local server listens on unless told otherwise — the
 *  one scanruler-mcp uses by default. */
const AGENT_PORT_DEFAULT = 7317

/** A port as typed or stored, or the default when it is not one. */
const agentPortOf = (value: unknown): number => {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : AGENT_PORT_DEFAULT
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    // Storage blocked: every preference reads as its default.
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

/** Start in the supplied light design; retain explicit Dark/System choices.
 *  index.html reads the same key for the first paint. */
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
  /** Whether a save or an export also puts up the big card (ui/SupportCard's
   *  SupportAsk). On by default, and only ever with `supportCard` on. */
  supportAsk: boolean
  /** When the card's "Don't show this again for a week" runs out, by
   *  `Date.now()`; 0 when it was not asked for. The settings window's switch
   *  ends it early. */
  supportAskOffUntil: number
  /** What lengths are shown and typed in. Only the screen: what is held,
   *  saved, exported to STEP and answered to an agent stays in millimetres
   *  (core/units). Millimetres until switched. */
  units: DisplayUnits
  /** Whether opening an STL asks what units its coordinates are in — the
   *  format carries none. On by default; the question's "Don't ask again"
   *  switches it off, and the settings window switches it back on. */
  askStlUnits: boolean
  /** The units an STL is taken to be in when the question is off, and the
   *  answer the question offers first: the last one given. */
  stlUnits: MeshUnits
  /** Whether this page connects to an AI agent's local server — see
   *  commands/bridge. Off unless switched on, here or by a pairing link, and
   *  never on before `agentDataOk`. */
  agentLink: boolean
  /** Whether the person has accepted, in this browser, that what an agent
   *  reads leaves the local-only promise behind (ui/AgentDataWarning). Asked
   *  once; a "no" is not remembered, so the next switching on asks again. */
  agentDataOk: boolean
  /** The connection was switched on before that was accepted: the warning is
   *  up, and nothing connects until it is answered. */
  agentDataAsking: boolean
  /** The port on 127.0.0.1 that server listens on. */
  agentPort: number
  /** The token it was started with, which the page presents. */
  agentToken: string
  /** SpaceMouse speed, times the default. */
  spaceMouseSpeed: number
  /** SpaceMouse axes that move the other way from the default. */
  spaceMouseReverse: SpaceMouseAxisId[]
  /** Whether a SpaceMouse has been attached in this browser. Its settings
   *  only show once one has, and keep showing on later visits, before the
   *  puck is touched — the browser only reports one after that. */
  spaceMouseSeen: boolean
  settingsOpen: boolean
  setUiTheme: (theme: UiTheme) => void
  setColormap: (id: ColormapId) => void
  setSectionLines: (px: number) => void
  setSheetLines: (px: number) => void
  setEdgeLines: (px: number) => void
  setHidePinsBehind: (on: boolean) => void
  setSupportCard: (on: boolean) => void
  setSupportAsk: (on: boolean) => void
  setSupportAskOffUntil: (time: number) => void
  setUnits: (units: DisplayUnits) => void
  setAskStlUnits: (on: boolean) => void
  setStlUnits: (units: MeshUnits) => void
  setAgentLink: (on: boolean) => void
  answerAgentData: (ok: boolean) => void
  setAgentPort: (port: number) => void
  setAgentToken: (token: string) => void
  setSpaceMouseSpeed: (speed: number) => void
  setSpaceMouseReversed: (axis: SpaceMouseAxisId, reversed: boolean) => void
  openSettings: (open: boolean) => void
}

export const usePrefs = create<PrefsState>()((set) => {
  const uiTheme = storedUiTheme()
  // A connection left on from before the warning existed asks first too.
  const agentLinkStored = read(AGENT_LINK_KEY) === '1'
  const agentDataOk = read(AGENT_DATA_OK_KEY) === '1'
  return {
    uiTheme,
    dark: resolveDark(uiTheme),
    colormap: colormapById(read(COLORMAP_KEY)).id,
    sectionLines: clampLineWidth(read(SECTION_LINES_KEY), SECTION_LINE_DEFAULT),
    sheetLines: clampLineWidth(read(SHEET_LINES_KEY), SHEET_LINE_DEFAULT),
    edgeLines: clampLineWidth(read(EDGE_LINES_KEY), EDGE_LINE_DEFAULT),
    hidePinsBehind: read(PINS_BEHIND_KEY) !== '0',
    supportCard: read(SUPPORT_CARD_KEY) !== '0',
    supportAsk: read(SUPPORT_ASK_KEY) !== '0',
    supportAskOffUntil: Number(read(SUPPORT_ASK_OFF_UNTIL_KEY)) || 0,
    units: displayUnitsOf(read(UNITS_KEY)) ?? 'mm',
    askStlUnits: read(ASK_STL_UNITS_KEY) !== '0',
    stlUnits: meshUnitsOf(read(STL_UNITS_KEY)) ?? 'mm',
    agentLink: agentLinkStored && agentDataOk,
    agentDataOk,
    agentDataAsking: agentLinkStored && !agentDataOk,
    agentPort: agentPortOf(read(AGENT_PORT_KEY)),
    agentToken: read(AGENT_TOKEN_KEY) ?? '',
    spaceMouseSpeed: spaceMouseSpeedOf(read(SPACE_MOUSE_SPEED_KEY)),
    spaceMouseReverse: spaceMouseReverseOf(read(SPACE_MOUSE_REVERSE_KEY)),
    spaceMouseSeen: read(SPACE_MOUSE_SEEN_KEY) === '1',
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
    setSupportAsk: (supportAsk) => {
      write(SUPPORT_ASK_KEY, supportAsk ? '1' : '0')
      write(SUPPORT_ASK_OFF_UNTIL_KEY, '0')
      set({ supportAsk, supportAskOffUntil: 0 })
    },
    setSupportAskOffUntil: (supportAskOffUntil) => {
      write(SUPPORT_ASK_OFF_UNTIL_KEY, String(supportAskOffUntil))
      set({ supportAskOffUntil })
    },
    setUnits: (value) => {
      const units = displayUnitsOf(value) ?? 'mm'
      write(UNITS_KEY, units)
      set({ units })
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
    setAgentLink: (on) =>
      set((s) => {
        if (on && !s.agentDataOk) return { agentDataAsking: true }
        write(AGENT_LINK_KEY, on ? '1' : '0')
        return { agentLink: on, agentDataAsking: false }
      }),
    answerAgentData: (ok) => {
      if (ok) write(AGENT_DATA_OK_KEY, '1')
      write(AGENT_LINK_KEY, ok ? '1' : '0')
      set({ agentDataOk: ok, agentLink: ok, agentDataAsking: false })
    },
    setAgentPort: (port) => {
      const agentPort = agentPortOf(port)
      write(AGENT_PORT_KEY, String(agentPort))
      set({ agentPort })
    },
    setAgentToken: (token) => {
      const agentToken = token.trim()
      write(AGENT_TOKEN_KEY, agentToken)
      set({ agentToken })
    },
    setSpaceMouseSpeed: (speed) => {
      const spaceMouseSpeed = spaceMouseSpeedOf(speed)
      write(SPACE_MOUSE_SPEED_KEY, String(spaceMouseSpeed))
      set({ spaceMouseSpeed })
    },
    setSpaceMouseReversed: (axis, reversed) =>
      set((s) => {
        const spaceMouseReverse = spaceMouseReverseOf(
          [...s.spaceMouseReverse.filter((a) => a !== axis), ...(reversed ? [axis] : [])].join(','),
        )
        write(SPACE_MOUSE_REVERSE_KEY, spaceMouseReverse.join(','))
        return { spaceMouseReverse }
      }),
    openSettings: (settingsOpen) => set({ settingsOpen }),
  }
})

// The puck reads its speed and reversed axes from here, at load and on every
// change; and the first puck attached in this browser is remembered, so its
// settings show from then on.
const tune = (s: PrefsState): void => tuneSpaceMouse({ speed: s.spaceMouseSpeed, reversed: s.spaceMouseReverse })
tune(usePrefs.getState())
usePrefs.subscribe((s, prev) => {
  if (s.spaceMouseSpeed !== prev.spaceMouseSpeed || s.spaceMouseReverse !== prev.spaceMouseReverse) tune(s)
})
watchSpaceMouse(() => {
  if (!spaceMouseAttached() || usePrefs.getState().spaceMouseSeen) return
  write(SPACE_MOUSE_SEEN_KEY, '1')
  usePrefs.setState({ spaceMouseSeen: true })
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
