// SPDX-License-Identifier: AGPL-3.0-only
// The units window: what an STL about to be opened is in. Put up by the
// import (state/unitsPromptStore) before it reads the file, with the last
// answer offered first; Open reads the file in the units picked, Cancel and
// Escape leave it unopened. "Don't ask again" makes the answer stand for
// every STL from here on — Settings → Files brings the question back.

import { useEffect, useState } from 'react'
import { MESH_UNITS, type MeshUnits } from '../core/meshUnits'
import { usePrefs } from '../state/prefsStore'
import { useUnitsPrompt } from '../state/unitsPromptStore'

export function UnitsModal() {
  const request = useUnitsPrompt((s) => s.request)
  const answer = useUnitsPrompt((s) => s.answer)
  const cancel = useUnitsPrompt((s) => s.cancel)
  const offered = usePrefs((s) => s.stlUnits)
  const [units, setUnits] = useState<MeshUnits>(offered)
  const [remember, setRemember] = useState(false)

  // Each question starts from the last answer, and without the switch set:
  // "Don't ask again" is a decision for each file it is put to, not a
  // leftover from the one before.
  useEffect(() => {
    if (!request) return
    setUnits(usePrefs.getState().stlUnits)
    setRemember(false)
  }, [request])

  // Escape dismisses, Enter opens. Captured, like the settings window's
  // keys, so the workspace behind never sees them.
  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        cancel()
      } else if (e.key === 'Enter') {
        e.stopPropagation()
        answer(units, remember)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request, units, remember, answer, cancel])

  if (!request) return null
  return (
    <div className="modalback" onClick={cancel}>
      <div
        className="modal units"
        data-test="units-modal"
        role="dialog"
        aria-labelledby="units-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modalhead">
          <h2 id="units-title">Units of {request.fileName}</h2>
          <button className="x" data-test="units-cancel" onClick={cancel} aria-label="Cancel">
            ×
          </button>
        </div>
        <p className="dim">
          An STL file carries no units — a 1 in it is whatever the program that wrote it meant.
          Say what this one is in and it is read in millimetres, like everything measured here.
        </p>
        <div className="setting">
          <span id="units-label">Coordinates in</span>
          <div className="keys" role="radiogroup" aria-labelledby="units-label">
            {MESH_UNITS.map((u) => (
              <button
                key={u.id}
                role="radio"
                aria-checked={units === u.id}
                className={units === u.id ? 'on' : undefined}
                data-test={`units-${u.id}`}
                onClick={() => setUnits(u.id)}
              >
                {u.label}
              </button>
            ))}
          </div>
        </div>
        <label className="checkrow settings-check">
          <input
            type="checkbox"
            data-test="units-remember"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>
            <b>Don't ask again</b> — read every STL in these units. Settings brings the question
            back.
          </span>
        </label>
        <div className="modalfoot">
          <button onClick={cancel}>Cancel</button>
          <button className="primary" data-test="units-open" onClick={() => answer(units, remember)}>
            Open
          </button>
        </div>
      </div>
    </div>
  )
}
