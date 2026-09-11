// SPDX-License-Identifier: AGPL-3.0-only
// Machine status strip: ready-lamp, what the tool is doing right now, the
// running tally of what has been measured, and the imprint. Nothing that is a
// switch — the ways of looking at the part are on the view bar in the corner
// of the stage, and what is set once and left is in Settings; a strip that
// held both was a row of small print nobody could find anything in.

import { useStore } from '../state/store'

export function StatusStrip() {
  const busy = useStore((s) => s.busy)
  const errorText = useStore((s) => s.errorText)
  const statusText = useStore((s) => s.statusText)
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const openImprint = useStore((s) => s.openImprint)

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
