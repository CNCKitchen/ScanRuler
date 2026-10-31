// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Hermann (CNC Kitchen) <stefan@cnckitchen.com>

// Imprint (Impressum) + privacy policy — German legal requirement
// (§ 5 DDG / Art. 13 DSGVO). Opened from the status strip.

import { plugins } from '../plugins/registry'
import { useStore } from '../state/store'
import { APP_VERSION } from '../version'
import { Modal } from './Modal'

export function ImprintModal() {
  const open = useStore((s) => s.imprintOpen)
  const close = useStore((s) => s.openImprint)

  if (!open) return null
  // The plugins' notices on the third-party software they ship.
  const notices = plugins().flatMap((p) => (p.notices ? [{ id: p.id, Notices: p.notices }] : []))
  return (
    <Modal labelledBy="imprint-title" onClose={() => close(false)}>
      <div className="modal imprint" onClick={(e) => e.stopPropagation()}>
        <div className="modalhead">
          <h2 id="imprint-title">Imprint &amp; Privacy Policy</h2>
          <button className="x" onClick={() => close(false)} aria-label="Close">
            ×
          </button>
        </div>
        <p className="dim" data-test="imprint-version">
          ScanRuler v{APP_VERSION} — quote the number when reporting a problem.
        </p>

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

        {notices.length > 0 && (
          <>
            <h3>Third-party software</h3>
            {notices.map(({ id, Notices }) => (
              <Notices key={id} />
            ))}
          </>
        )}

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
            the session only, are never uploaded, and are gone when you close the tab. The one
            exception is the optional agent connection: if you switch it on and accept its warning,
            what the AI agent you connected reads is processed by that agent and, unless its model
            runs on your computer, by the model’s provider, under that provider’s terms. ScanRuler
            itself sends none of this anywhere and has no part in that processing.
          </li>
          <li>
            The only things this tool stores on your device are four preferences — your chosen
            mouse navigation scheme, viewport colour scheme, STEP export style, and whether the
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
    </Modal>
  )
}
