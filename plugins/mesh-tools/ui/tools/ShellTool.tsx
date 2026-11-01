// SPDX-License-Identifier: AGPL-3.0-only
// Shell: a closed part hollowed to a wall, or an open surface thickened to
// one, on the side chosen.

import { useLength } from '../../../../src/app/useUnits'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { NumberField } from '../../../../src/ui/NumberField'
import type { ThickenSide } from '../../core/offset'
import { shellModeOf, useMeshTools } from '../../state/meshStore'
import { count, typedLen } from '../meshFormat'
import { SurveyWait } from '../SurveyWait'

const SIDES: { id: ThickenSide; label: string; title: string }[] = [
  { id: 'in', label: 'Inward', title: 'The wall grows behind the surface — the scanned surface stays the outside' },
  { id: 'out', label: 'Outward', title: 'The wall grows in front of the surface — the scanned surface becomes the inside' },
  { id: 'both', label: 'Both sides', title: 'Half the thickness each way — the scanned surface runs down the middle of the wall' },
]

export function ShellTool({ ready, busy, onShell }: { ready: boolean; busy: boolean; onShell: (mode: 'hollow' | 'thicken') => void }) {
  const m = useMeshTools()
  const survey = m.shellSurvey
  const mode = survey ? shellModeOf(survey) : null
  const len = useLength()
  const t = typedLen(m.shellThickness, len.units)
  const twice = typedLen(2 * m.shellThickness, len.units)
  const way = m.shellSide === 'out' ? 'outward' : m.shellSide === 'both' ? 'to both sides' : 'inward'
  const n = (k: number, one: string, many: string) => `${count(k)} ${k === 1 ? one : many}`

  return (
    <div className="group" data-test="shell-tool">
      <div className="sec-head">
        Shell / hollow
        <InfoDot title="Hollowing a part, or thickening a surface">
          <p>
            A <b>closed</b> part is hollowed: its outside stays as scanned, and an inner wall the
            thickness in from it all round seals a cavity — what a resin print is hollowed with.
            The inner wall is built from the part's distance field, not by moving the scan in:
            where the part is thinner than twice the wall it simply stays solid, and the wall never
            comes nearer the outside than the thickness. It is smoother and lighter than the scan,
            needing none of its detail. The cavity is sealed; open it with <b>Boolean</b> or{' '}
            <b>Cut</b> if it should drain.
          </p>
          <p>
            An <b>open</b> surface — one side of a part, a sheet — is thickened into a solid: a
            second skin the thickness from it, <b>inward</b> (the scanned surface stays the
            outside), <b>outward</b> or half to <b>both sides</b>, and a wall round every rim
            joining the two.
          </p>
          <p>
            A part closed but for a few small holes — no larger than Fill holes would fill — is
            asked to have them filled first, so it can be hollowed; thickened as it is, it would
            come out with a wall round every hole. <b>Cut</b> shows the inside without cutting.{' '}
            <b>Ctrl+Z</b> puts the part back.
          </p>
        </InfoDot>
      </div>

      <NumberField
        label={mode === 'hollow' ? 'Wall' : 'Thickness'}
        testId="shell-thickness"
        value={m.shellThickness}
        step={0.5}
        min={0.001}
        kind="length"
        disabled={busy}
        onCommit={m.setShellThickness}
        hint={`The wall left round the cavity of a hollowed part, or the thickness an open surface is given. It starts at a hundred-and-twenty-fifth of the part's size — ${len.fmt(2, 0)} for a part a hand's width across.`}
      />

      {mode !== null && mode !== 'hollow' && (
        <div className="moderow shell-sides" role="radiogroup" aria-label="Which way to thicken">
          {SIDES.map((x) => (
            <button
              key={x.id}
              role="radio"
              aria-checked={m.shellSide === x.id}
              className={m.shellSide === x.id ? 'on' : undefined}
              data-test={`shell-side-${x.id}`}
              disabled={busy}
              onClick={() => m.setShellSide(x.id)}
              title={x.title}
            >
              {x.label}
            </button>
          ))}
        </div>
      )}

      {ready && survey === null && <SurveyWait looking="Looking at the mesh…" />}
      {survey && mode === 'hollow' && (
        <p className="hint" data-test="shell-closed">
          The mesh is closed, so it is hollowed: the outside stays as it is, and an inner wall {t}
          in from it seals a cavity. Where the part is thinner than {twice} it stays solid.
          {survey.bad > 0 ? ` ${n(survey.bad, 'edge is', 'edges are')} shared by more than two triangles — the inside is read by which way the surface faces, and may be off there.` : ''}
        </p>
      )}
      {survey && mode === 'thicken' && (
        <p className="hint" data-test="shell-open">
          The mesh is an open surface — {n(survey.rims, 'open rim', 'open rims')} — so it is thickened
          into a solid: a second skin {t} {way}, and a wall round every rim.
        </p>
      )}
      {survey && mode === 'holes' && (
        <p className="warnnote" data-test="shell-holes">
          ⚠ The mesh is closed but for {n(survey.holes, 'hole', 'holes')} under {typedLen(survey.holeSize, len.units)}.
          Hollowing needs it closed: fill {survey.holes === 1 ? 'it' : 'them'} first — or thicken it as
          it is, with a wall round every hole.
        </p>
      )}

      {mode === 'holes' ? (
        <div className="toolrow">
          <button data-test="shell-thicken-anyway" disabled={!ready || busy} onClick={() => onShell('thicken')} title="Thicken the surface as it is, a wall round every hole">
            Thicken as it is
          </button>
          <button className="primary" data-test="shell-fill-first" data-confirm={1} disabled={busy} onClick={() => m.setTool('holes')} title="Go to Fill holes, to close the holes and hollow the part after">
            Fill holes first
          </button>
        </div>
      ) : (
        <button
          className="primary block"
          data-test="shell-run"
          data-confirm={1}
          disabled={!ready || busy || mode === null}
          onClick={() => mode && onShell(mode === 'hollow' ? 'hollow' : 'thicken')}
        >
          {m.editing ? (
            <>
              <span className="spinner" />
              {mode === 'hollow' ? 'Hollowing…' : 'Thickening…'}
            </>
          ) : mode === 'hollow' ? (
            `Hollow with a ${t} wall`
          ) : mode === 'thicken' ? (
            `Thicken ${t} ${way}`
          ) : (
            'Shell'
          )}
        </button>
      )}
    </div>
  )
}
