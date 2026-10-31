// SPDX-License-Identifier: AGPL-3.0-only
// The warning before the agent connection first comes on, in Settings or by a
// pairing link: from then on the person's data does not stay on this computer.
// Up while prefsStore's agentDataAsking is; nothing connects until "Connect the
// agent" is pressed, and Cancel, Escape or a click beside it leave it off. The
// answer "yes" is remembered in this browser.

import { usePrefs } from '../state/prefsStore'
import { Modal } from './Modal'

export function AgentDataWarning() {
  const asking = usePrefs((s) => s.agentDataAsking)
  const answer = usePrefs((s) => s.answerAgentData)

  if (!asking) return null
  return (
    <Modal labelledBy="agent-data-title" onClose={() => answer(false)}>
      <div
        className="modal agentdata"
        data-test="agent-data-warning"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modalhead">
          <h2 id="agent-data-title">Your data will no longer stay on this computer</h2>
          <button className="x" onClick={() => answer(false)} aria-label="Cancel">
            ×
          </button>
        </div>
        <p>
          Without an agent, everything stays in this browser. With one connected, what the agent
          reads — measurements, reports, pictures of the part, file names, notes, and any file it
          opens itself — is processed by the agent and the AI model behind it. <b>Unless that model
          runs on this computer, all of this goes to the model’s provider</b>, under that provider’s
          terms.
        </p>
        <p>
          ScanRuler itself sends nothing anywhere: the connection only reaches the agent’s helper on
          this computer. Don’t connect an agent while you work on parts you may not share with its
          provider.
        </p>
        <p className="dim">
          Asked once in this browser. Settings → Agents switches the connection off at any time.
        </p>
        <div className="modalfoot">
          <button data-test="agent-data-decline" onClick={() => answer(false)}>
            Cancel
          </button>
          <button className="primary" data-test="agent-data-accept" onClick={() => answer(true)}>
            Connect the agent
          </button>
        </div>
      </div>
    </Modal>
  )
}
