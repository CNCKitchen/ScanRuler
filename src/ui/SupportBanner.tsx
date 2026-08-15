// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Hermann (CNC Kitchen) <stefan@cnckitchen.com>

// Support banner — the same call-to-action filaSim and bumpmesh.com carry. A
// dismissible pill floated at the bottom-centre of the stage, clear of the
// legend on the right. Dismissal is remembered in sessionStorage, so it stays
// gone for the current tab but returns on the next visit.

import { useState } from 'react'

const KEY = 'scaneval.supportBanner.dismissed'

export function SupportBanner() {
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })
  if (hidden) return null
  const dismiss = () => {
    try {
      sessionStorage.setItem(KEY, '1')
    } catch {
      /* private mode — just hide via state */
    }
    setHidden(true)
  }
  return (
    <div className="supportbanner">
      <span>
        Support this tool? Shop at{' '}
        <a href="https://geni.us/CNCStoreSim" target="_blank" rel="noopener noreferrer">
          CNCKitchen.STORE
        </a>{' '}
        or send a tip via{' '}
        <a href="https://www.paypal.me/CNCKitchen" target="_blank" rel="noopener noreferrer">
          PayPal
        </a>{' '}
        /{' '}
        <a href="https://ko-fi.com/cnckitchen" target="_blank" rel="noopener noreferrer">
          Ko-fi
        </a>
      </span>
      <button className="sb-x" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
