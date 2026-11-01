// SPDX-License-Identifier: AGPL-3.0-only
// Remove islands: the specks floating off the scan, under a size, found,
// marked on the part and deleted once asked.

import { useLength } from '../../../../src/app/useUnits'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { NumberField } from '../../../../src/ui/NumberField'
import { useMeshTools } from '../../state/meshStore'
import { SurveyWait } from '../SurveyWait'
import { count, typedLen } from '../meshFormat'

export function IslandsTool({ ready, busy, onRemove }: { ready: boolean; busy: boolean; onRemove: () => void }) {
  const pieceSize = useMeshTools((s) => s.pieceSize)
  const setPieceSize = useMeshTools((s) => s.setPieceSize)
  const survey = useMeshTools((s) => s.survey)
  const editing = useMeshTools((s) => s.editing)
  const confirming = useMeshTools((s) => s.confirming)
  const setConfirming = useMeshTools((s) => s.setConfirming)
  const len = useLength()
  // A count for another size than the one in the field is on its way out.
  const s = survey && survey.minSize === pieceSize ? survey : null
  const removable = s !== null && s.islands > 0 && s.islands < s.pieces
  const islands = (n: number) => `${count(n)} island${n === 1 ? '' : 's'}`

  return (
    <div className="group" data-test="islands-tool">
      <div className="sec-head">
        Remove islands
        <InfoDot title="Removing islands">
          <p>
            Scans come with islands: stray patches of the turntable, a fleck of dust, spray floating
            off the part — each a piece of surface joined to nothing else. They throw every reading
            of the whole part: the automatic alignment's directions, a best fit that reaches for
            them, a reduced mesh that carries them along.
          </p>
          <p>
            Every piece smaller across than the size below is an island, and is marked on the part:
            tinted orange and ringed, the ring showing faintly through the part for one behind it or
            inside it. Nothing is deleted until you have looked and said so. A size rather than
            "keep the largest", because a scan is often several real pieces — the two balls of a
            ball bar and the rod between them all stay.
          </p>
          <p>
            They are deleted from the edited copy; the other workspaces measure what is left once
            the copy is taken into use. <b>Ctrl+Z</b> puts the islands back.
          </p>
        </InfoDot>
      </div>

      <NumberField
        label="Smaller than"
        testId="islands-size"
        value={pieceSize}
        step={0.5}
        min={0.001}
        kind="length"
        disabled={busy}
        onCommit={setPieceSize}
        hint="A piece whose bounding box is smaller than this across is an island. It starts at a hundredth of the part's size."
      />

      {ready && !s && <SurveyWait looking="Looking for islands…" />}
      {s && (
        <>
          <div className="kv" data-test="islands-pieces">
            <span className="name">Pieces in the scan</span>
            <b>{count(s.pieces)}</b>
          </div>
          <div className="kv" data-test="islands-count">
            <span className="name">Islands, under {typedLen(s.minSize, len.units)}</span>
            <b>
              {count(s.islands)} · {count(s.islandTriangles)} △
            </b>
          </div>
          {removable && (
            <p className="hint" data-test="islands-gap">
              Marked on the part in orange, each in a ring. The largest is{' '}
              {len.fmt(s.largestIsland!, 2)} across, the smallest piece that stays{' '}
              {len.fmt(s.smallestKept!, 2)}.
            </p>
          )}
          {s.islands === 0 && (
            <p className="hint" data-test="islands-none">
              No piece of the scan is smaller than that
              {s.smallestKept !== null && s.pieces > 1 ? ` — the smallest is ${len.fmt(s.smallestKept, 2)} across` : ''}.
            </p>
          )}
          {s.islands > 0 && s.islands === s.pieces && (
            <p className="warnnote" data-test="islands-all">
              ⚠ Every piece of the scan is smaller than that — nothing would be left.
            </p>
          )}
        </>
      )}

      {confirming && removable ? (
        <div className="confirmbox" data-test="islands-confirm" role="alertdialog" aria-label="Delete the islands">
          <p>
            Delete the <b>{islands(s.islands)}</b> marked on the part — {count(s.islandTriangles)}{' '}
            triangles — from the edited copy?
          </p>
          <p className="hint">Ctrl+Z puts them back.</p>
          <div className="toolrow">
            <button data-test="islands-keep" onClick={() => setConfirming(false)} title="Leave the scan as it is (Esc)">
              Keep them
            </button>
            <button
              className="primary"
              data-test="islands-delete"
              data-confirm={1}
              disabled={busy}
              onClick={onRemove}
              title="Take the marked islands off the scan (Enter)"
            >
              Delete {islands(s.islands)}
            </button>
          </div>
        </div>
      ) : (
        <button
          className="primary block"
          data-test="remove-islands"
          disabled={!ready || busy || !removable}
          onClick={() => setConfirming(true)}
        >
          {editing ? (
            <>
              <span className="spinner" />
              Removing…
            </>
          ) : removable ? (
            `Remove ${islands(s.islands)}…`
          ) : (
            'Remove'
          )}
        </button>
      )}
    </div>
  )
}
