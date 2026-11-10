// SPDX-License-Identifier: AGPL-3.0-only
// Settings — the instrument's own: how it looks, how it is driven, how
// heavily it draws, and whether it guides. One dialog for everything that is
// a property of the operator rather than of the part on screen, opened from
// the top bar and remembered per browser; nothing in it is saved with a
// project. The ways of *looking* at a part — see-through, mesh, back faces —
// are not here: those change with the job in hand and live on the view bar,
// in the corner of the stage.

import { useState, useSyncExternalStore } from 'react'
import { COLORMAPS, colormapById, cssRgb, legendGradient } from '../core/field/colormap'
import { CREASE_ANGLE_DEG, CREASE_ANGLE_MAX, CREASE_ANGLE_MIN, CREASE_ANGLE_STEP, type CreaseMode } from '../core/geometry/crease'
import { MESH_UNITS, type MeshUnits } from '../core/meshUnits'
import { DISPLAY_UNITS } from '../core/units'
import { AGENT_STATUS, useAgentLink } from '../commands/agentLink'
import { betaOn, betaPlugins, pluginEnabled, plugins, setBetaOn } from '../plugins/registry'
import { useHintPrefs } from '../state/hintStore'
import { UI_THEMES, usePrefs } from '../state/prefsStore'
import { useStore } from '../state/store'
import { LINE_MAX, LINE_MIN, LINE_STEP } from '../viewer/lineWidths'
import { MARK_SIZE_MAX, MARK_SIZE_MIN, MARK_SIZE_STEP } from '../viewer/markSize'
import { SCHEMES, schemeById } from '../viewer/navSchemes'
import {
  SPACE_MOUSE_SPEED_MAX,
  SPACE_MOUSE_SPEED_MIN,
  SPACE_MOUSE_SPEED_STEP,
  spaceMouseName,
  watchSpaceMouse,
  type SpaceMouseAxisId,
} from '../viewer/spaceMouse'
import { VIEW_THEMES, themeById } from '../viewer/viewThemes'
import { useDismiss } from './useDismiss'
import { NumberInput } from './NumberField'

/** The puck's six motions by 3Dconnexion's names, in the order its trainer
 *  walks through them. */
const PUCK_AXES: { id: SpaceMouseAxisId; label: string }[] = [
  { id: 'tx', label: 'Pan left/right' },
  { id: 'tz', label: 'Pan up/down' },
  { id: 'ty', label: 'Zoom' },
  { id: 'rx', label: 'Tilt' },
  { id: 'rz', label: 'Spin' },
  { id: 'ry', label: 'Roll' },
]

/** The beta workspaces in the build, each with a switch — off until switched
 *  on, and taken into use or put away when the page is next loaded, since a
 *  plugin installs once. Nothing at all in a build that has none. */
function BetaWorkspaces() {
  // The switches read storage; this re-renders them when one is flipped.
  const [, flipped] = useState(0)
  const beta = betaPlugins()
  if (beta.length === 0) return null
  const pending = beta.some((p) => pluginEnabled(p) !== plugins().includes(p))
  return (
    <>
      <h3>Beta</h3>
      {beta.map((p) => (
        <label key={p.id} className="checkrow settings-check">
          <input
            type="checkbox"
            data-test={`toggle-beta-${p.id}`}
            checked={betaOn(p.id)}
            onChange={(e) => {
              setBetaOn(p.id, e.target.checked)
              flipped((n) => n + 1)
            }}
          />
          <span>
            <b>{p.workspace?.label ?? p.name}</b> — {p.workspace ? `${p.workspace.title}. ` : ''}A
            workspace still in beta: it may change, and work done in it may not open the same in a
            later version. Off, a project made with it keeps that work, untouched.
          </span>
        </label>
      ))}
      {pending && (
        <div className="setting" data-test="beta-reload">
          <small>
            Takes effect when the page is reloaded.{' '}
            <button type="button" onClick={() => location.reload()}>
              Reload now
            </button>
          </small>
        </div>
      )}
    </>
  )
}

export function SettingsModal() {
  const open = usePrefs((s) => s.settingsOpen)
  const close = usePrefs((s) => s.openSettings)
  const uiTheme = usePrefs((s) => s.uiTheme)
  const setUiTheme = usePrefs((s) => s.setUiTheme)
  const colormap = usePrefs((s) => s.colormap)
  const setColormap = usePrefs((s) => s.setColormap)
  const sectionLines = usePrefs((s) => s.sectionLines)
  const markSize = usePrefs((s) => s.markSize)
  const setMarkSize = usePrefs((s) => s.setMarkSize)
  const setSectionLines = usePrefs((s) => s.setSectionLines)
  const sheetLines = usePrefs((s) => s.sheetLines)
  const setSheetLines = usePrefs((s) => s.setSheetLines)
  const edgeLines = usePrefs((s) => s.edgeLines)
  const setEdgeLines = usePrefs((s) => s.setEdgeLines)
  const supportCard = usePrefs((s) => s.supportCard)
  const setSupportCard = usePrefs((s) => s.setSupportCard)
  const supportAsk = usePrefs((s) => s.supportAsk)
  const setSupportAsk = usePrefs((s) => s.setSupportAsk)
  const supportAskOffUntil = usePrefs((s) => s.supportAskOffUntil)
  const askStlUnits = usePrefs((s) => s.askStlUnits)
  const setAskStlUnits = usePrefs((s) => s.setAskStlUnits)
  const stlUnits = usePrefs((s) => s.stlUnits)
  const units = usePrefs((s) => s.units)
  const setUnits = usePrefs((s) => s.setUnits)
  const setStlUnits = usePrefs((s) => s.setStlUnits)
  const navScheme = useStore((s) => s.navScheme)
  const setNavScheme = useStore((s) => s.setNavScheme)
  const viewTheme = useStore((s) => s.viewTheme)
  const setViewTheme = useStore((s) => s.setViewTheme)
  const creaseMode = useStore((s) => s.creaseMode)
  const setCreaseMode = useStore((s) => s.setCreaseMode)
  const creaseAngle = useStore((s) => s.creaseAngle)
  const setCreaseAngle = useStore((s) => s.setCreaseAngle)
  const hintsOn = useHintPrefs((s) => s.on)
  const setHintsOn = useHintPrefs((s) => s.setOn)
  const agentLink = usePrefs((s) => s.agentLink)
  const setAgentLink = usePrefs((s) => s.setAgentLink)
  const agentDataAsking = usePrefs((s) => s.agentDataAsking)
  const agentPort = usePrefs((s) => s.agentPort)
  const setAgentPort = usePrefs((s) => s.setAgentPort)
  const agentToken = usePrefs((s) => s.agentToken)
  const setAgentToken = usePrefs((s) => s.setAgentToken)
  const link = useAgentLink()
  const puck = useSyncExternalStore(watchSpaceMouse, spaceMouseName)
  const puckSeen = usePrefs((s) => s.spaceMouseSeen)
  const puckSpeed = usePrefs((s) => s.spaceMouseSpeed)
  const setPuckSpeed = usePrefs((s) => s.setSpaceMouseSpeed)
  const puckReverse = usePrefs((s) => s.spaceMouseReverse)
  const setPuckReversed = usePrefs((s) => s.setSpaceMouseReversed)

  // Escape closes it. Captured, like the imprint's, so the workspace's own
  // Escape handling — which would discard the draft behind the dialog — never
  // sees the key. With the agent warning up over it, the key is the warning's.
  useDismiss(open && !agentDataAsking, () => close(false))

  if (!open) return null
  const scheme = schemeById(navScheme)
  const theme = themeById(viewTheme)
  const map = colormapById(colormap)
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

        <h3>Units</h3>
        <div className="setting">
          <span id="units-label">Lengths in</span>
          <div className="keys" role="radiogroup" aria-labelledby="units-label">
            {DISPLAY_UNITS.map((u) => (
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
          <small>
            What is shown and typed. Files, projects and agent answers stay in millimetres.
          </small>
        </div>

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
        <div className="setting colormaps">
          <span id="colormap-label">Colour map</span>
          <div className="cmaps" role="radiogroup" aria-labelledby="colormap-label">
            {COLORMAPS.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={colormap === m.id}
                className={colormap === m.id ? 'on' : undefined}
                data-test={`colormap-${m.id}`}
                title={m.hint}
                onClick={() => setColormap(m.id)}
              >
                {/* The ramp as a legend shows it, low end on the left, with
                    the two caps a reading off either end of the scale wears. */}
                <span className="cmap-ramp" aria-hidden="true">
                  <i style={{ background: cssRgb(m.under) }} />
                  <i style={{ background: legendGradient(m, null, false, 'right') }} />
                  <i style={{ background: cssRgb(m.over) }} />
                </span>
                {m.label}
              </button>
            ))}
          </div>
          <small>
            <b>{map.label}.</b> {map.hint}. Every map painted on the part, and the scale beside
            it, is drawn in it; the block at either end is what a reading past that end of the
            scale wears.
          </small>
        </div>
        <div className="setting">
          <label htmlFor="crease">Sharp edges</label>
          <select
            id="crease"
            data-test="crease-mode"
            value={creaseMode}
            onChange={(e) => setCreaseMode(e.target.value as CreaseMode)}
          >
            <option value="on">Always sharp</option>
            <option value="auto">Auto — sharp on a CAD-like mesh</option>
            <option value="off">Always smooth</option>
          </select>
          <label htmlFor="creaseangle">Sharp from</label>
          <div className="range">
            <input
              id="creaseangle"
              data-test="crease-angle"
              type="range"
              min={CREASE_ANGLE_MIN}
              max={CREASE_ANGLE_MAX}
              step={CREASE_ANGLE_STEP}
              value={creaseAngle}
              disabled={creaseMode === 'off'}
              onChange={(e) => setCreaseAngle(Number(e.target.value))}
            />
            <output htmlFor="creaseangle">{creaseAngle}°</output>
          </div>
          <small>
            Whether an edge of the scan is shaded as a crease, each face with its own normal, or
            smoothed across so a box looks pillowed — and from what angle between its two faces an
            edge counts as sharp. <b>Always sharp</b> draws a CAD mesh's faces flat and a scan's
            real edges — the rim of a bore, a step — as edges; noise seldom tips a scan's triangles
            that far, and if it still shows, a larger angle, 50° or 60°, leaves it smooth.{' '}
            <b>Auto</b> draws the creases only on a mesh that reads as a tessellation of CAD, a scan
            smooth all over. A reference part is always drawn sharp, from {CREASE_ANGLE_DEG}°.
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
          <small>
            A <b>3Dconnexion SpaceMouse</b> works beside any of these, in Chrome and Edge: push or
            pull the puck to zoom, slide it to pan, tilt, twist and roll it to turn the part. It connects
            the first time you touch it, and drives the view the mouse was last over.
          </small>
        </div>
        {(puck !== null || puckSeen) && (
          <>
            <div className="setting" data-test="spacemouse-settings">
              <label htmlFor="puckspeed">SpaceMouse speed</label>
              <div className="range">
                <input
                  id="puckspeed"
                  data-test="spacemouse-speed"
                  type="range"
                  min={SPACE_MOUSE_SPEED_MIN}
                  max={SPACE_MOUSE_SPEED_MAX}
                  step={SPACE_MOUSE_SPEED_STEP}
                  value={puckSpeed}
                  onChange={(e) => setPuckSpeed(Number(e.target.value))}
                />
                <output htmlFor="puckspeed">{puckSpeed.toFixed(2)}×</output>
              </div>
              <small data-test="spacemouse-status">
                {puck !== null ? (
                  <>
                    Connected: <b>{puck.replace(/\s*\(.*\)$/, '')}</b>.
                  </>
                ) : (
                  <>Not connected — touch the puck to connect it.</>
                )}
              </small>
            </div>
            <div className="setting puckaxes-row">
              <span>Reverse</span>
              <div className="puckaxes" role="group" aria-label="Reverse SpaceMouse axes">
                {PUCK_AXES.map((a) => {
                  const on = puckReverse.includes(a.id)
                  return (
                    <button
                      key={a.id}
                      type="button"
                      data-test={`spacemouse-reverse-${a.id}`}
                      className={on ? 'on' : undefined}
                      aria-pressed={on}
                      onClick={() => setPuckReversed(a.id, !on)}
                    >
                      {a.label}
                    </button>
                  )
                })}
              </div>
              <small>
                By default the puck moves the part, the way the 3Dconnexion driver does. The browser
                reads the puck directly, so the driver's own speed and reversed axes do not reach
                here; set them here instead.
              </small>
            </div>
          </>
        )}

        <h3>Files</h3>
        <label className="checkrow settings-check">
          <input
            type="checkbox"
            data-test="toggle-ask-stl-units"
            checked={askStlUnits}
            onChange={(e) => setAskStlUnits(e.target.checked)}
          />
          <span>
            <b>Ask what units an STL is in</b> — the format carries none, and a part read at the
            wrong scale measures wrong in every number after. Off, every STL is read in the units
            below without asking.
          </span>
        </label>
        <div className="setting">
          <label htmlFor="stlunits">STL import units</label>
          <select
            id="stlunits"
            data-test="stl-units"
            value={stlUnits}
            onChange={(e) => setStlUnits(e.target.value as MeshUnits)}
          >
            {MESH_UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
          <small>
            What an STL is read in when the question is off, and the answer the question offers
            first — the last one given. A PLY or OBJ is always read in millimetres; a STEP file
            says its own.
          </small>
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
          <label htmlFor="sheetlines">2D fitted curves</label>
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
            The lines, circles and splines fitted over a flatbed scan in 2D Measure, and the
            callouts drawn with them.
          </small>
        </div>
        <div className="setting">
          <label htmlFor="marksize">Points and grips</label>
          <div className="range">
            <input
              id="marksize"
              data-test="mark-size"
              type="range"
              min={MARK_SIZE_MIN}
              max={MARK_SIZE_MAX}
              step={MARK_SIZE_STEP}
              value={markSize}
              onChange={(e) => setMarkSize(Number(e.target.value))}
            />
            <output htmlFor="marksize">{markSize.toFixed(2)}×</output>
          </div>
          <small>
            How large the marks that keep their size on the screen are drawn on the part: points,
            picked spots, the arrows and bars on an element being made, and the section's handle.
            Larger is easier to see and take hold of on a big screen; elements with a size of their
            own, such as cylinders and planes, keep it.
          </small>
        </div>
        <div className="setting">
          <label htmlFor="edgelines">2D edges</label>
          <div className="range">
            <input
              id="edgelines"
              data-test="edge-lines"
              type="range"
              min={LINE_MIN}
              max={LINE_MAX}
              step={LINE_STEP}
              value={edgeLines}
              onChange={(e) => setEdgeLines(Number(e.target.value))}
            />
            <output htmlFor="edgelines">{edgeLines.toFixed(1)} px</output>
          </div>
          <small>
            The edge chains the curves are fitted to — found in the scan, or cut by a section.
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

        <h3>Agents</h3>
        <label className="checkrow settings-check">
          <input
            type="checkbox"
            data-test="toggle-agent-link"
            checked={agentLink}
            onChange={(e) => setAgentLink(e.target.checked)}
          />
          <span>
            <b>Local agent connection</b> — let an AI agent on this computer (Claude Code, Claude
            Desktop, Cursor …) drive this tab through its ScanRuler tools, the scanruler-mcp server.
            You watch every step here and can undo it. <b>Your data no longer stays on this
            computer:</b> what the agent reads — measurements, reports, pictures of the part, file
            names, notes — is processed by the agent and goes to its model’s provider, unless the
            model runs on this computer. ScanRuler itself sends nothing anywhere; the connection is
            to 127.0.0.1.
          </span>
        </label>
        <div className="setting">
          <label htmlFor="agentport">Port</label>
          <NumberInput
            id="agentport"
            data-test="agent-port"
            min={1}
            max={65535}
            value={agentPort}
            onCommit={(v) => {
              // A port outside 1–65535 is left as it was, not put back to
              // the default.
              if (v !== null && Number.isInteger(v) && v >= 1 && v <= 65535) setAgentPort(v)
            }}
          />
          <label htmlFor="agenttoken">Token</label>
          <input
            id="agenttoken"
            data-test="agent-token"
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={agentToken}
            onChange={(e) => setAgentToken(e.target.value)}
          />
          <small data-test="agent-status">
            {agentLink ? (
              <b>
                {AGENT_STATUS[link.status]}
                {link.status === 'connected' && link.server?.version ? ` (scanruler-mcp ${link.server.version})` : ''}.
              </b>
            ) : null}{' '}
            {link.detail ?? (
              <>
                <code>npx -y scanruler-mcp@latest --pair</code> prints the port and the token, and a link
                that fills them in.
              </>
            )}
          </small>
        </div>

        <BetaWorkspaces />

        <h3>Support</h3>
        <label className="checkrow settings-check">
          <input
            type="checkbox"
            data-test="toggle-support-card"
            checked={supportCard}
            onChange={(e) => setSupportCard(e.target.checked)}
          />
          <span>
            <b>Support card</b> — the thank-you in the corner of the stage, with the ways to
            give something back. Its × closes it for this visit; switched off here it stays
            away, the big one below with it.
          </span>
        </label>
        <label className="checkrow settings-check">
          <input
            type="checkbox"
            data-test="toggle-support-ask"
            checked={supportCard && supportAsk && Date.now() >= supportAskOffUntil}
            disabled={!supportCard}
            onChange={(e) => setSupportAsk(e.target.checked)}
          />
          <span>
            <b>Big card on saving</b> — the same thank-you in the middle of the screen after a save
            or an export, at most once in ten minutes. The file does not wait for it. Its "Don't
            show this again for a week" shows here as off until the week is over.
          </span>
        </label>
      </div>
    </div>
  )
}
