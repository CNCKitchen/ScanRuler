// SPDX-License-Identifier: AGPL-3.0-only
// Machine status strip: ready-lamp, what the tool is doing right now, the
// running tally of what has been measured, and the overlay toggle.

import { useDeviation } from '../state/deviationStore'
import { useShell } from '../state/shellStore'
import { useHintPrefs } from '../state/hintStore'
import { useStore } from '../state/store'
import { SCHEMES, schemeById } from '../viewer/navSchemes'
import { VIEW_THEMES, themeById } from '../viewer/viewThemes'

export function StatusStrip() {
  const busy = useStore((s) => s.busy)
  const errorText = useStore((s) => s.errorText)
  const statusText = useStore((s) => s.statusText)
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const showOverlays = useStore((s) => s.showOverlays)
  const setShowOverlays = useStore((s) => s.setShowOverlays)
  const showBackfaces = useStore((s) => s.showBackfaces)
  const setShowBackfaces = useStore((s) => s.setShowBackfaces)
  const openImprint = useStore((s) => s.openImprint)
  const navScheme = useStore((s) => s.navScheme)
  const setNavScheme = useStore((s) => s.setNavScheme)
  const scheme = schemeById(navScheme)
  const viewTheme = useStore((s) => s.viewTheme)
  const setViewTheme = useStore((s) => s.setViewTheme)
  const theme = themeById(viewTheme)
  const hintsOn = useHintPrefs((s) => s.on)
  const setHintsOn = useHintPrefs((s) => s.setOn)
  // The overlays are the measure workspace's own: elsewhere they are put away
  // whatever this says, and a switch that does nothing is worse than no switch.
  const elementsWorkspace = useShell((s) => s.workspace === 'elements')
  // How the deviation workspace is looked at, as against what it measures: the
  // two parts side by side instead of one inside the other, and whether the map
  // is painted on at all. Both are ways of seeing rather than settings of the
  // measurement, which is what puts them down here with the backfaces and not in
  // the panel beside the numbers they do not change.
  const onDeviation = useShell((s) => s.workspace === 'deviation')
  const onReference = useDeviation((s) => s.source === 'reference')
  const split = useDeviation((s) => s.split)
  const setSplit = useDeviation((s) => s.setSplit)
  const showMap = useDeviation((s) => s.showMap)
  const setShowMap = useDeviation((s) => s.setShowMap)
  const nominalName = useDeviation((s) => s.nominalName)
  const nominalBusy = useDeviation((s) => s.nominalBusy)
  const hasMap = useDeviation((s) =>
    s.source === 'element' ? s.elementStatus === 'ready' : s.mapStatus === 'ready',
  )
  const fileName = useStore((s) => s.fileName)
  // Nothing to stand a second viewport up with until both parts are in.
  const canSplit = Boolean(fileName) && Boolean(nominalName) && !nominalBusy

  const fitting = draft?.status === 'fitting' || elements.some((e) => e.status === 'fitting')
  const lamp = errorText ? 'lamp err' : busy || fitting ? 'lamp busy' : 'lamp'
  const state = errorText ? 'ERROR' : busy ? 'LOADING' : fitting ? 'FITTING' : 'READY'

  const done = elements.filter((e) => e.fit)
  const dimensions = useStore((s) => s.dimensions)

  return (
    <footer className="strip">
      <div>
        <span className={lamp} /> {state}
      </div>
      {elements.length > 0 && (
        <div>
          ELEMENTS <b>{done.length}</b>
          {done.length !== elements.length && ` of ${elements.length}`} · DIM{' '}
          <b>{dimensions.length}</b>
        </div>
      )}
      <div className="msg grow">
        {errorText ? <span className="warn">⚠ {errorText}</span> : statusText}
      </div>
      <div className="nav">
        <label htmlFor="navscheme">CONTROLS</label>
        <select
          id="navscheme"
          value={scheme.id}
          onChange={(e) => setNavScheme(e.target.value)}
          title="Match the mouse navigation of the CAD tool you are used to"
        >
          {SCHEMES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="navhint">{scheme.hint}</span>
      </div>
      {/* Beside the controls because it is the same kind of setting: how the
          viewport behaves and how it looks, neither of them a property of the
          part on screen. No line of explanation beside it, unlike the controls:
          the strip is one row that never wraps, and the option showing in the
          dropdown says what the scheme is on its own. */}
      <div className="nav view">
        <label htmlFor="viewtheme">VIEW</label>
        <select
          id="viewtheme"
          data-test="view-theme"
          value={theme.id}
          onChange={(e) => setViewTheme(e.target.value)}
          title={`How the part is shown — ${theme.hint}. What has been measured keeps its colour either way: the element tints and the deviation ramp are the same in both.`}
        >
          {VIEW_THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      {elementsWorkspace && (
        <button
          className={showOverlays ? 'on' : ''}
          onClick={() => setShowOverlays(!showOverlays)}
          title="Show fitted elements & distance callouts in the viewport"
        >
          ▤ OVERLAYS
        </button>
      )}
      {onDeviation && onReference && (
        <button
          className={split ? 'viewsw on' : 'viewsw'}
          data-test="toggle-split"
          aria-pressed={split}
          disabled={!canSplit}
          onClick={() => setSplit(!split)}
          title={
            canSplit
              ? 'Show the scan and the reference in two viewports that turn, pan and zoom together'
              : 'Load both the scan and the reference to compare them side by side'
          }
        >
          ◫ <span className="btxt">SPLIT VIEW</span>
        </button>
      )}
      {onDeviation && (
        <button
          className={showMap ? 'viewsw on' : 'viewsw'}
          data-test="toggle-colormap"
          aria-pressed={showMap}
          disabled={!hasMap}
          onClick={() => setShowMap(!showMap)}
          title={
            hasMap
              ? 'Paint the measured deviation onto the scan. Off leaves the bare surface — nothing measured is lost, and the figures, the readings and the pins all still report it.'
              : 'Nothing measured yet — the colour plot appears with the map'
          }
        >
          ▩ <span className="btxt">COLOUR PLOT</span>
        </button>
      )}
      <button
        className={showBackfaces ? 'on' : ''}
        data-test="toggle-backfaces"
        aria-pressed={showBackfaces}
        onClick={() => setShowBackfaces(!showBackfaces)}
        title="Colour the far side of every triangle — holes in the scan and inverted normals stop looking like solid part"
      >
        ◱ BACKFACES
      </button>
      <button
        className={hintsOn ? 'on' : ''}
        data-test="toggle-hints"
        aria-pressed={hintsOn}
        onClick={() => setHintsOn(!hintsOn)}
        title="Ring the control to press next, until you have been through a workspace once. Switching it back on starts the guidance over."
      >
        ◉ <span className="btxt">HINTS</span>
      </button>
      <button
        className="stripimprint"
        onClick={() => openImprint(true)}
        title="Impressum & Datenschutzerklärung"
      >
        § <span className="btxt">IMPRINT</span>
      </button>
      <a href="https://www.cnckitchen.com" target="_blank" rel="noreferrer">
        LOCAL ONLY · FILES NEVER LEAVE YOUR BROWSER
      </a>
    </footer>
  )
}
