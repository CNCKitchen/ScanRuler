// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Hermann (CNC Kitchen) <stefan@cnckitchen.com>

// Support card — the same call-to-action bumpmesh.com carries, in the
// bottom-left corner of the stage: a thank-you, then the three ways to give
// something back. Not a modal: the user came to look at a part, and a dialog
// over it would be a dialog over the thing they came to see. The corner is the
// one the instrument itself leaves empty — the colour scale and its statistics
// run down the right edge, the orientation gizmo sits bottom right.
//
// SupportAsk below is the modal, bumpmesh's, for the one moment the user has
// what they came for: a save or an export has just handed over a file. It holds
// nothing up. The file has already gone (app/exports.saveFile), workers carry
// on behind it, and one click anywhere or any of Escape and Enter takes it away.
//
// The close is for this page load only, held in a module-level flag rather than
// in storage: the card is meant to be seen once per visit, and a visit ends
// when the tab is reloaded. Keeping the flag outside the component means the
// close survives the card being unmounted and remounted mid-session (the point
// picker takes the stage and takes the card with it) — a card that came back
// while the user was still working would read as one that cannot be closed.
//
// Putting it away for good is a setting — Support card in ⚙ Settings, held in
// the prefs store with the instrument's others — for the operator who has seen
// it and works in the tool every day.

import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { usePrefs } from '../state/prefsStore'
import { useStore } from '../state/store'
import { ASK_OFF_MS, useSupportAsk } from '../state/supportAskStore'

let closedThisLoad = false

const LINKS = [
  {
    kind: 'store',
    icon: '🛒',
    label: 'Visit CNCKitchen.STORE',
    href: 'https://geni.us/CNCStoreScan',
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

const supportLinks = (onOpen?: () => void) =>
  LINKS.map((l) => (
    <a
      key={l.kind}
      className={`sc-btn ${l.kind}`}
      href={l.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onOpen}
    >
      <span className="sc-icon" aria-hidden="true">
        {l.icon}
      </span>
      {l.label}
    </a>
  ))

export function SupportCard() {
  const [closed, setClosed] = useState(closedThisLoad)
  const shown = usePrefs((s) => s.supportCard)
  if (closed || !shown) return null
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
      {supportLinks()}
    </aside>
  )
}

export function SupportAsk() {
  const open = useSupportAsk((s) => s.open)
  const closeAsk = useSupportAsk((s) => s.close)
  const errorText = useStore((s) => s.errorText)
  const setSupportAskOffUntil = usePrefs((s) => s.setSupportAskOffUntil)
  const [offForAWeek, setOffForAWeek] = useState(false)

  const close = () => {
    if (offForAWeek) setSupportAskOffUntil(Date.now() + ASK_OFF_MS)
    setOffForAWeek(false)
    closeAsk()
  }

  // An error that comes up meanwhile is not left behind an ask for money.
  useEffect(() => {
    if (open && errorText) closeAsk()
  }, [open, errorText, closeAsk])

  if (!open) return null
  const store = LINKS[0]
  return (
    <Modal labelledBy="support-ask-title" className="supportask-back" onClose={close} onEnter={close} initialFocus="[data-test=support-ask-close]">
      <div
        className="modal supportask"
        data-test="support-ask"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="support-ask-title">Thanks for using ScanRuler by CNC Kitchen!</h2>
        <p>
          This tool is provided <b>completely free</b> by CNC Kitchen. Your file is on its way —
          why not check out the{' '}
          <a href={store.href} target="_blank" rel="noopener noreferrer" onClick={close}>
            store
          </a>{' '}
          that helps us keep making things like this?
        </p>
        {supportLinks(close)}
        <label className="supportask-off">
          <input
            type="checkbox"
            data-test="support-ask-off"
            checked={offForAWeek}
            onChange={(e) => setOffForAWeek(e.target.checked)}
          />
          Don't show this again for a week
        </label>
        <div className="supportask-foot">
          <button data-test="support-ask-close" onClick={close}>
            Close &amp; Continue
          </button>
        </div>
      </div>
    </Modal>
  )
}
