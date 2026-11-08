// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Stefan Hermann (CNC Kitchen) <stefan@cnckitchen.com>

// Imprint (Impressum) + privacy policy — German legal requirement
// (§ 5 DDG / Art. 13 DSGVO). Opened from the status strip.

import { plugins } from '../plugins/registry'
import { useStore } from '../state/store'
import { APP_VERSION } from '../version'
import { useDismiss } from './useDismiss'

export function ImprintModal() {
  const open = useStore((s) => s.imprintOpen)
  const close = useStore((s) => s.openImprint)

  // Escape closes it. Captured, so the workspace's own Escape handling — which
  // would discard the draft behind the dialog — never sees the key.
  useDismiss(open, () => close(false))

  if (!open) return null
  // The plugins' notices on the third-party software they ship.
  const notices = plugins().flatMap((p) => (p.notices ? [{ id: p.id, Notices: p.notices }] : []))
  return (
    <div className="modalback" onClick={() => close(false)}>
      <div className="modal imprint" onClick={(e) => e.stopPropagation()}>
        <div className="modalhead">
          <h2>Imprint &amp; Privacy Policy</h2>
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
            are processed entirely in your browser and are never uploaded. So that unsaved work
            survives a closed or crashed tab, a recovery copy of it, the files included, is kept
            on your device in your browser’s IndexedDB storage. Copies left by closed tabs are
            offered back when you open ScanRuler again, and are deleted when you discard them,
            after 14 days, once more than ten have built up, or when you clear this site’s data
            in your browser.
            The one exception is the optional agent connection: if you switch it on and accept its warning,
            what the AI agent you connected reads is processed by that agent and, unless its model
            runs on your computer, by the model’s provider, under that provider’s terms. ScanRuler
            itself sends none of this anywhere and has no part in that processing.
          </li>
          <li>
            Besides that recovery copy, this tool stores your settings on your device, in your
            browser’s localStorage: preferences such as the navigation scheme, colours, units,
            export and fit options, the guided hints and the Beta switch, and, if you use the
            agent connection, its port and the token that pairs it with the agent server. No
            personal data is stored.
          </li>
          <li>
            A link that opens a file (an address with <code>?open=</code> or <code>/s/</code>)
            makes your browser fetch that file from where the link points: for{' '}
            <code>/s/</code> this site’s own file store on Cloudflare, for <code>?open=</code> any
            server the link names, which may belong to someone else and sees your IP address as
            any website does.
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
