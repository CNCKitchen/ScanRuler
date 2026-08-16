// SPDX-License-Identifier: AGPL-3.0-only
// One model the workspace needs, in the left panel. Shared by both
// workspaces, so a scan is opened the same way whichever one you are in.

import { useRef } from 'react'
import { MESH_ACCEPT, MESH_FORMATS } from '../core/formats'

export function ModelSlot({
  role,
  name,
  detail,
  dotColor,
  busy,
  accept = MESH_ACCEPT,
  formats = MESH_FORMATS,
  onOpen,
}: {
  role: string
  name: string | null
  detail: string
  dotColor: string
  busy: boolean
  /** What the file picker offers. The reference slot takes CAD as well. */
  accept?: string
  /** The same list in prose, for the empty slot. */
  formats?: string
  onOpen: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="slot">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
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
        <span>{name ? detail : formats}</span>
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
