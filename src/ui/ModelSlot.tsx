// SPDX-License-Identifier: AGPL-3.0-only
// One model the workspace needs, in the left panel. Shared by both
// workspaces, so a scan is opened the same way whichever one you are in.

import { useRef } from 'react'

export function ModelSlot({
  role,
  name,
  detail,
  dotColor,
  busy,
  onOpen,
}: {
  role: string
  name: string | null
  detail: string
  dotColor: string
  busy: boolean
  onOpen: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="slot">
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
      <span
        className="dot"
        style={{ background: name ? dotColor : 'transparent', borderColor: dotColor }}
      />
      <div className="slotname">
        <b title={name ?? undefined}>{name ?? `No ${role.toLowerCase()} loaded`}</b>
        <span>{name ? detail : 'STL, PLY or OBJ · mm'}</span>
      </div>
      <button
        data-test={`open-${role.toLowerCase()}`}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {name ? 'Replace…' : 'Open…'}
      </button>
    </div>
  )
}
