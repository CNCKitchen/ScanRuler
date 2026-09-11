// SPDX-License-Identifier: AGPL-3.0-only
// Settings — the instrument's own: how it looks, how it is driven, how
// heavily it draws, and whether it guides. One dialog for everything that is
// a property of the operator rather than of the part on screen, opened from
// the top bar and remembered per browser; nothing in it is saved with a
// project. The ways of *looking* at a part — see-through, mesh, back faces —
// are not here: those change with the job in hand and live on the view bar,
// in the corner of the stage.

import { useEffect } from 'react'
import { useHintPrefs } from '../state/hintStore'
import { UI_THEMES, usePrefs } from '../state/prefsStore'
import { useStore } from '../state/store'
import { LINE_MAX, LINE_MIN, LINE_STEP } from '../viewer/lineWidths'
import { SCHEMES, schemeById } from '../viewer/navSchemes'
import { VIEW_THEMES, themeById } from '../viewer/viewThemes'

export function SettingsModal() {
  const open = usePrefs((s) => s.settingsOpen)
  const close = usePrefs((s) => s.openSettings)
  const uiTheme = usePrefs((s) => s.uiTheme)
  const setUiTheme = usePrefs((s) => s.setUiTheme)
  const sectionLines = usePrefs((s) => s.sectionLines)
  const setSectionLines = usePrefs((s) => s.setSectionLines)
  const sheetLines = usePrefs((s) => s.sheetLines)
  const setSheetLines = usePrefs((s) => s.setSheetLines)
  const navScheme = useStore((s) => s.navScheme)
  const setNavScheme = useStore((s) => s.setNavScheme)
  const viewTheme = useStore((s) => s.viewTheme)
  const setViewTheme = useStore((s) => s.setViewTheme)
  const hintsOn = useHintPrefs((s) => s.on)
  const setHintsOn = useHintPrefs((s) => s.setOn)

  // Escape closes it. Captured, like the imprint's, so the workspace's own
  // Escape handling — which would discard the draft behind the dialog — never
  // sees the key.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])

  if (!open) return null
  const scheme = schemeById(navScheme)
  const theme = themeById(viewTheme)
  return (
    <div className="modalback" onClick={() => close(false)}>
      <div
        className="modal settings"
        data-test="settings-modal"
        role="dialog"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modalhead">
          <h2 id="settings-title">Settings</h2>
          <button
            className="x"
            data-test="settings-close"
            onClick={() => close(false)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="dim">
          How the instrument looks and behaves. Remembered in this browser — nothing here is a
          property of the part, and none of it is saved with a project.
        </p>

        <h3>Appearance</h3>
        <div className="setting">
          <span id="uitheme-label">Interface</span>
          <div className="keys" role="radiogroup" aria-labelledby="uitheme-label">
            {UI_THEMES.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={uiTheme === t.id}
                className={uiTheme === t.id ? 'on' : undefined}
                data-test={`ui-theme-${t.id}`}
                onClick={() => setUiTheme(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <small>
            Light or dark chassis. <b>System</b> follows the operating system's setting, and
            changes with it.
          </small>
        </div>
        <div className="setting">
          <label htmlFor="viewtheme">Colour mode</label>
          <select
            id="viewtheme"
            data-test="view-theme"
            value={theme.id}
            onChange={(e) => setViewTheme(e.target.value)}
          >
            {VIEW_THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <small>
            {theme.hint}. What has been measured keeps its colour either way — the element
            tints and the deviation ramp are the same in both.
          </small>
        </div>

        <h3>Navigation</h3>
        <div className="setting">
          <label htmlFor="navscheme">Mouse controls</label>
          <select id="navscheme" value={scheme.id} onChange={(e) => setNavScheme(e.target.value)}>
            {SCHEMES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <small className="navhint">{scheme.hint}</small>
        </div>

        <h3>Lines</h3>
        <div className="setting">
          <label htmlFor="sectionlines">Section cuts</label>
          <div className="range">
            <input
              id="sectionlines"
              data-test="section-lines"
              type="range"
              min={LINE_MIN}
              max={LINE_MAX}
              step={LINE_STEP}
              value={sectionLines}
              onChange={(e) => setSectionLines(Number(e.target.value))}
            />
            <output htmlFor="sectionlines">{sectionLines.toFixed(1)} px</output>
          </div>
          <small>
            How heavy a section's cut is drawn on the part in 3D Measure. The curves measured
            on its sheet follow in proportion.
          </small>
        </div>
        <div className="setting">
          <label htmlFor="sheetlines">2D Measure curves</label>
          <div className="range">
            <input
              id="sheetlines"
              data-test="sheet-lines"
              type="range"
              min={LINE_MIN}
              max={LINE_MAX}
              step={LINE_STEP}
              value={sheetLines}
              onChange={(e) => setSheetLines(Number(e.target.value))}
            />
            <output htmlFor="sheetlines">{sheetLines.toFixed(1)} px</output>
          </div>
          <small>
            The lines, circles and splines fitted over a flatbed scan, and the callouts drawn
            with them.
          </small>
        </div>

        <h3>Guidance</h3>
        <label className="checkrow settings-check">
          <input
            type="checkbox"
            data-test="toggle-hints"
            checked={hintsOn}
            onChange={(e) => setHintsOn(e.target.checked)}
          />
          <span>
            <b>Guided hints</b> — ring the control to press next, until you have been through
            a workspace twice. Switching it back on starts the guidance over.
          </span>
        </label>
      </div>
    </div>
  )
}
