// SPDX-License-Identifier: AGPL-3.0-only
// Machine status strip: ready-lamp, what the tool is doing right now, the
// running tally of what has been measured, and the overlay toggle.

import { useStore } from '../state/store'
import { SIGMA_LABELS } from '../core/summary'
import { SCHEMES, schemeById } from '../viewer/navSchemes'

export function StatusStrip() {
  const busy = useStore((s) => s.busy)
  const errorText = useStore((s) => s.errorText)
  const statusText = useStore((s) => s.statusText)
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const sigma = useStore((s) => s.settings.sigma)
  const showOverlays = useStore((s) => s.showOverlays)
  const setShowOverlays = useStore((s) => s.setShowOverlays)
  const openImprint = useStore((s) => s.openImprint)
  const navScheme = useStore((s) => s.navScheme)
  const setNavScheme = useStore((s) => s.setNavScheme)
  const scheme = schemeById(navScheme)

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
      <div>
        FIT <b>gaussian</b> · <b>{SIGMA_LABELS[sigma].toLowerCase()}</b>
      </div>
      {elements.length > 0 && (
        <div>
          ELEMENTS <b>{done.length}</b>
          {done.length !== elements.length && ` of ${elements.length}`} · DIM{' '}
          <b>{dimensions.length}</b>
        </div>
      )}
      <div className="msg grow">{errorText ? <span className="warn">⚠ {errorText}</span> : statusText}</div>
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
      <button
        className={showOverlays ? 'on' : ''}
        onClick={() => setShowOverlays(!showOverlays)}
        title="Show fitted elements & distance callouts in the viewport"
      >
        ▤ OVERLAYS
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
