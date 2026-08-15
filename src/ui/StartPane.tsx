// SPDX-License-Identifier: AGPL-3.0-only
// What a workspace shows before it has the models it needs: one tile per
// model, each its own drop target, on the stage where the files are going to
// land. Both workspaces use it, so opening a model looks the same whichever
// one you are in — only the number of tiles differs.

import { useRef, useState } from 'react'

export interface StartSlot {
  role: string
  what: string
  name: string | null
  onOpen: (file: File) => void
}

function Tile({ role, what, name, onOpen }: StartSlot) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

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
        const file = e.dataTransfer?.files?.[0]
        if (file) onOpen(file)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".stl,.ply,.obj"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onOpen(f)
          e.target.value = ''
        }}
      />
      <div className="starttile-role">{role}</div>
      <div className="starttile-what">{what}</div>
      {name ? (
        <div className="starttile-name" title={name}>
          ✓ {name}
        </div>
      ) : (
        <div className="starttile-drop">Drop it here</div>
      )}
      <button className={name ? undefined : 'primary'} onClick={() => inputRef.current?.click()}>
        {name ? 'Replace…' : 'Choose file…'}
      </button>
    </div>
  )
}

export function StartPane({
  title,
  blurb,
  slots,
}: {
  title: string
  blurb: string
  slots: StartSlot[]
}) {
  // Once something is loaded the pane stops covering the stage and drops to a
  // card along the bottom: the model that just arrived is the thing the user
  // wants to look at, and a full-bleed prompt would hide it.
  const compact = slots.some((s) => s.name)

  return (
    <div className={'startpane' + (compact ? ' compact' : '')} data-test="start-pane">
      <div className="starthead">
        <b>{title}</b>
        <span>
          {compact ? 'One to go — load the other model to align and measure.' : blurb}
        </span>
      </div>
      <div className="starttiles">
        {slots.map((slot) => (
          <Tile key={slot.role} {...slot} />
        ))}
      </div>
      <div className="startfoot">
        Drag &amp; drop works anywhere in the window — the first empty slot takes it.
      </div>
    </div>
  )
}
