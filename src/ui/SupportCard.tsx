// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Hermann (CNC Kitchen) <stefan@cnckitchen.com>

// Support card — the same call-to-action bumpmesh.com carries, in the
// bottom-left corner of the stage: a thank-you, then the three ways to give
// something back. Deliberately not a modal. bumpmesh can afford one because it
// has a wait to fill while the STL is processed; here the user came to look at
// a part, and a dialog over it would be a dialog over the thing they came to
// see. The corner is the one the instrument itself leaves empty — the colour
// scale and its statistics run down the right edge, the orientation gizmo sits
// bottom right.
//
// The close is for this page load only, held in a module-level flag rather than
// in storage: the card is meant to be seen once per visit, and a visit ends
// when the tab is reloaded. Keeping the flag outside the component means the
// close survives the card being unmounted and remounted mid-session (the point
// picker takes the stage and takes the card with it) — a card that came back
// while the user was still working would read as one that cannot be closed.

import { useState } from 'react'

let closedThisLoad = false

const LINKS = [
  {
    kind: 'store',
    icon: '🛒',
    label: 'Visit CNCKitchen.STORE',
    href: 'https://geni.us/CNCStoreSim',
  },
  {
    kind: 'paypal',
    icon: '💙',
    label: 'Send a tip on PayPal',
    href: 'https://www.paypal.me/CNCKitchen',
  },
  {
    kind: 'kofi',
    icon: '☕',
    label: 'Send a tip on Ko-fi',
    href: 'https://ko-fi.com/cnckitchen',
  },
] as const

export function SupportCard() {
  const [closed, setClosed] = useState(closedThisLoad)
  if (closed) return null
  const close = () => {
    closedThisLoad = true
    setClosed(true)
  }
  return (
    <aside className="supportcard" data-test="support-card">
      <div className="sc-head">
        <b>Thanks for using ScanRuler!</b>
        <button className="sc-x" onClick={close} title="Close" aria-label="Close">
          ×
        </button>
      </div>
      <p>
        This tool is provided <b>completely free</b> by CNC Kitchen. Once you have finished
        measuring, why not have a look at the store that keeps us making things like this?
      </p>
      {LINKS.map((l) => (
        <a
          key={l.kind}
          className={`sc-btn ${l.kind}`}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="sc-icon" aria-hidden="true">
            {l.icon}
          </span>
          {l.label}
        </a>
      ))}
    </aside>
  )
}
