// SPDX-License-Identifier: AGPL-3.0-only
// The front door: what a workspace shows on an empty stage, before there is any
// part at all. One tile per model it will need, each its own drop target, where
// the files are going to land. Every workspace uses it, so opening a model looks
// the same in every one of them — only the number of tiles differs.
//
// It goes the moment a scan arrives and does not come back. A card over the
// model is a card over the thing the user loaded it to look at, and anything the
// workspace still needs after that has a row of its own in the panel to say so.

import { useRef, useState } from 'react'
import { SCAN_ACCEPT } from '../core/formats'
import { usePulse } from '../app/useHints'
import { SAMPLE_DETAIL } from '../app/sampleScan'
import { bundleFiles, droppedFiles } from '../app/scanFiles'
import { HiddenFileInput } from './ModelSlot'

export interface StartSlot {
  role: string
  what: string
  name: string | null
  /** What this slot's file picker offers; the scan default when omitted. */
  accept?: string
  onOpen: (file: File) => void
}

function Tile({ role, what, name, accept = SCAN_ACCEPT, onOpen }: StartSlot) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  // Keyed to the step rather than to this pane, so that the tile and the
  // panel's slot for the same model light up together — they are one action
  // offered twice, and the ring should not suggest otherwise.
  const pulse = usePulse(`open-${role.toLowerCase()}`)

  return (
    <div
      className={'starttile' + (name ? ' filled' : '') + (over ? ' over' : '')}
      data-test={`start-${role.toLowerCase()}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        // The scan's tile takes a textured OBJ's files, or their folder.
        if (accept !== SCAN_ACCEPT) {
          const file = e.dataTransfer?.files?.[0]
          if (file) onOpen(file)
          return
        }
        void droppedFiles(e.dataTransfer).then((files) => {
          const file = bundleFiles(files)
          if (file) onOpen(file)
        })
      }}
    >
      <HiddenFileInput inputRef={inputRef} accept={accept} onOpen={onOpen} multiple={accept === SCAN_ACCEPT} />
      <div className="starttile-role">{role}</div>
      <div className="starttile-what">{what}</div>
      {name ? (
        <div className="starttile-name" title={name}>
          ✓ {name}
        </div>
      ) : (
        <div className="starttile-drop">Drop it here</div>
      )}
      <button
        className={((name ? '' : 'primary ') + (pulse ? 'pulse' : '')).trim() || undefined}
        onClick={() => inputRef.current?.click()}
      >
        {name ? 'Replace…' : 'Choose file…'}
      </button>
    </div>
  )
}

export function StartPane({
  title,
  blurb,
  slots,
  skip,
  onOpenSample,
}: {
  title: string
  blurb: string
  slots: StartSlot[]
  /** A way past the door for a workspace that can work with no model at
   *  all, from a blank stage. */
  skip?: { label: string; title: string; onClick: () => void }
  /** For someone with no scan to hand: the one that ships with the build. */
  onOpenSample?: () => Promise<void>
}) {
  // A workspace that wants two models can have the second one dropped first —
  // a STEP file can only ever be the reference — so the prompt says what is
  // still outstanding rather than repeating the blurb at someone who has
  // already started.
  const started = slots.some((s) => s.name)
  const [fetching, setFetching] = useState(false)

  return (
    <div className="startpane" data-test="start-pane">
      <div className="starthead">
        <b>{title}</b>
        <span>{started ? 'One to go — load the scan to measure it.' : blurb}</span>
      </div>
      <div className="starttiles">
        {slots.map((slot) => (
          <Tile key={slot.role} {...slot} />
        ))}
      </div>
      <div className="startfoot">
        Drag &amp; drop works anywhere in the window — the first empty slot takes it.
      </div>
      {onOpenSample && (
        <div className="startsample">
          <button
            data-test="start-sample"
            title={SAMPLE_DETAIL}
            disabled={fetching}
            onClick={() => {
              setFetching(true)
              void onOpenSample().finally(() => setFetching(false))
            }}
          >
            {fetching ? 'Opening…' : 'Open a sample scan'}
          </button>
          <small>No scan to hand? {SAMPLE_DETAIL}.</small>
        </div>
      )}
      {skip && (
        <div className="startskip">
          <button className="ghost" data-test="start-skip" title={skip.title} onClick={skip.onClick}>
            {skip.label}
          </button>
        </div>
      )}
    </div>
  )
}
