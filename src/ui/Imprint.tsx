// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Hermann (CNC Kitchen) <stefan@cnckitchen.com>

// Imprint (Impressum) + privacy policy — German legal requirement
// (§ 5 DDG / Art. 13 DSGVO). Opened from the status strip.

import { useEffect } from 'react'
import { useStore } from '../state/store'

export function ImprintModal() {
  const open = useStore((s) => s.imprintOpen)
  const close = useStore((s) => s.openImprint)

  // Escape closes it. Captured, so the workspace's own Escape handling — which
  // would discard the draft behind the dialog — never sees the key.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])

  if (!open) return null
  return (
    <div className="modalback" onClick={() => close(false)}>
      <div className="modal imprint" onClick={(e) => e.stopPropagation()}>
        <div className="modalhead">
          <h2>Imprint &amp; Privacy Policy</h2>
          <button className="x" onClick={() => close(false)} aria-label="Close">
            ×
          </button>
        </div>

        <h3>Imprint (Impressum)</h3>
        <p>
          CNC Kitchen
          <br />
          Stefan Hermann
          <br />
          Bahnhofstr. 2
          <br />
          88145 Hergatz
          <br />
          Germany
        </p>
        <p>
          Email: <a href="mailto:contact@cnckitchen.com">contact@cnckitchen.com</a>
          <br />
          Phone: <a href="tel:+491752011824">+49 175 2011824</a>
          <br />
          <span className="dim">
            The phone number is for legal/business inquiries only — not for support.
          </span>
        </p>
        <p>
          EU Online Dispute Resolution platform:{' '}
          <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener noreferrer">
            ec.europa.eu/consumers/odr
          </a>
        </p>

        <h3>Privacy Policy (Datenschutzerklärung)</h3>
        <p>
          Responsible party (Verantwortlicher gem. Art. 4 Abs. 7 DSGVO): Stefan Hermann,
          Bahnhofstr. 2, 88145 Hergatz, Germany.
        </p>
        <ul>
          <li>
            This website is hosted on Cloudflare (Cloudflare, Inc., 101 Townsend St, San
            Francisco, CA 94107, USA). When you visit this site, Cloudflare may process your IP
            address in server logs to deliver the site and protect it against attacks. Legal
            basis: Art. 6(1)(f) DSGVO (legitimate interest in providing the website). See{' '}
            <a
              href="https://www.cloudflare.com/privacypolicy/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Cloudflare’s Privacy Policy
            </a>
            .
          </li>
          <li>
            Your scans, reference models, fitted elements and every measurement made from them
            are processed entirely in your browser. They are held in memory for the duration of
            the session only, are never uploaded, and are gone when you close the tab.
          </li>
          <li>
            The only things this tool stores on your device are whether you dismissed the
            support banner, kept in your browser’s sessionStorage for the current tab, and three
            preferences — your chosen mouse navigation scheme, STEP export style, and whether the
            guided hints are shown and which workspaces you have already been through — kept in
            your browser’s localStorage. No personal data is stored.
          </li>
          <li>This website does not use cookies, analytics, or any tracking technologies.</li>
          <li>
            This site contains links to external websites (e.g., GitHub, CNCKitchen.STORE,
            PayPal, Ko-fi). These sites have their own privacy policies, over which we have no
            control.
          </li>
          <li>
            Under the GDPR you have the right to access, rectification, erasure, restriction of
            processing, data portability, and the right to lodge a complaint with a supervisory
            authority.
          </li>
        </ul>
      </div>
    </div>
  )
}
