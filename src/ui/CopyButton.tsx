// SPDX-License-Identifier: AGPL-3.0-only
// A button that copies something and says so: the label flips to a tick for a
// moment after each click. The timer lives in an effect so it is cleaned up —
// a copy right before unmount must not set state on a component that is gone.

import { useEffect, useState } from 'react'

export function CopyButton({
  label,
  className,
  disabled,
  onCopy,
}: {
  label: string
  className?: string
  disabled?: boolean
  onCopy: () => void
}) {
  // A click counter rather than a boolean, so copying again while the tick is
  // still up restarts the two seconds instead of quietly doing nothing.
  const [clicks, setClicks] = useState(0)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (clicks === 0) return
    setCopied(true)
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [clicks])
  return (
    <button
      className={className}
      disabled={disabled}
      onClick={() => {
        onCopy()
        setClicks((n) => n + 1)
      }}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  )
}
