// SPDX-License-Identifier: AGPL-3.0-only
// Flip normals: the triangles turned over, so they face the other way — the
// whole part, or the surface marked on it.

import { ToolActions } from '../../../../src/ui/ToolActions'
import { useState } from 'react'
import { useMark } from '../../../../src/state/markStore'
import { useStore } from '../../../../src/state/store'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { MarkTools } from '../../../../src/ui/MarkTools'
import { useMeshTools } from '../../state/meshStore'

export type FlipScope = 'all' | 'marked'

export function FlipTool({
  ready,
  busy,
  onFlip,
  onClear,
}: {
  ready: boolean
  busy: boolean
  onFlip: (scope: FlipScope) => void
  onClear: () => void
}) {
  const marked = useMark((s) => s.count)
  const editing = useMeshTools((s) => s.editing)
  const backfaces = useStore((s) => s.showBackfaces)
  // Which key the flip in flight came from, to turn that one to a spinner.
  const [asked, setAsked] = useState<FlipScope>('all')
  const flip = (scope: FlipScope) => {
    setAsked(scope)
    onFlip(scope)
  }
  const label = (scope: FlipScope, text: string) =>
    editing && asked === scope ? (
      <>
        <span className="spinner" />
        Flipping…
      </>
    ) : (
      text
    )

  return (
    <div className="group" data-test="flip-tool">
      <div className="sec-head">
        Flip normals
        <InfoDot title="Flipping normals">
          <p>
            Which side of a surface is its outside is set by the order of each triangle's corners.
            A part exported inside-out faces in everywhere, and a scan stitched from patches can
            have some of them facing in — and the thickness map, the alignment,{' '}
            <b>Shrink/expand</b>, <b>Shell/hollow</b> and <b>Boolean</b> all go by which way the
            surface faces.
          </p>
          <p>
            A part that plainly encloses its volume inside-out is turned the right way out when it
            is opened; an open scan, a sheet, or one with patches facing both ways is left as it
            was wound. <b>Backfaces</b>, in the menu over the view bar's Scan key, colours the
            inside of every triangle, so surface facing the wrong way shows.
          </p>
          <p>
            <b>Flip all</b> turns every triangle over. <b>Flip marked</b> turns over the surface
            you mark with a <b>window</b>, a <b>brush</b> or a <b>lasso</b> — a triangle when all
            three of its corners are marked, exactly the triangles shown in amber. Nothing moves.
            It flips the edited copy; <b>Ctrl+Z</b> turns it back.
          </p>
        </InfoDot>
      </div>

      <MarkTools escapeNote="The marking stays until it is flipped or cleared." onClear={onClear} />

      <div className="toolrow">
        <ToolActions><button
          className={marked > 0 ? 'primary' : undefined}
          data-test="flip-marked"
          // Enter, or a middle click, flips what was just marked — never the
          // whole part, which a stray click would turn over.
          data-confirm={1}
          disabled={!ready || busy || marked === 0}
          onClick={() => flip('marked')}
          title="Turn the marked surface over — the triangles with all three corners marked"
        >
          {label('marked', 'Flip marked')}
        </button></ToolActions>
        <ToolActions><button
          className={marked > 0 ? undefined : 'primary'}
          data-test="flip-all"
          disabled={!ready || busy}
          onClick={() => flip('all')}
          title="Turn every triangle of the part over"
        >
          {label('all', 'Flip all')}
        </button></ToolActions>
      </div>
      {ready && marked === 0 && !editing && (
        <p className="hint">Mark the surface that faces the wrong way — pick Window, Brush or Lasso — or flip the whole part.</p>
      )}
      {ready && !backfaces && (
        <p className="hint" data-test="flip-backfaces-hint">
          Turn on <b>Backfaces</b> over the Scan key to see which way the surface faces.
        </p>
      )}
    </div>
  )
}
