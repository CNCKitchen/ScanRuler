// SPDX-License-Identifier: AGPL-3.0-only
// Which control a new user should press next, read off the work itself.
//
// Deliberately not a scripted tour: nothing here counts clicks or remembers
// how far through a sequence anyone is. Each workspace is a short ladder of
// "what is still missing", answered from the same state the panels are drawn
// from. That is what lets it survive doing the steps out of order, undoing
// one, or dropping a different part in halfway through — and it is what makes
// it impossible for the ring to sit on a step that is already done.
//
// The ladder is optimistic about whether a control can be pressed: it names
// the step, and the ring is suppressed in CSS on anything disabled. So while a
// fit is still being collected, "Create element" is the named step but wears
// nothing, and the ring appears the moment the fit is ready.

/** One workspace's worth of guidance. The workspace ids are the tracks. */
export type HintTrack = 'elements' | 'deviation' | 'thickness' | 'flat'

export interface HintStep {
  /** data-test of the control to ring — one control, in one place on screen. */
  target: string
  /** One line for the chip over the model, used only where nothing else on the
   *  stage is already saying it. */
  text: string
}

/** What the ladder has to say: the step to press next, `'done'` once the
 *  workflow has been carried through to a result of its own, or null while the
 *  user is inside a step that narrates itself. */
export type HintResult = HintStep | 'done' | null

export interface HintInput {
  workspace: HintTrack
  /** Anything loading, fitting, aligning or measuring. Nothing is worth
   *  pointing at while the tool is mid-computation. */
  busy: boolean
  scanLoaded: boolean

  // Measure workspace.
  /** Elements that actually have geometry — a failed or pending fit is not a
   *  step the user has finished. */
  fittedElements: number
  dimensions: number
  draftOpen: boolean
  dimDraftOpen: boolean
  alignDraftOpen: boolean

  // Deviation workspace.
  onElement: boolean
  referenceLoaded: boolean
  aligned: boolean
  mapReady: boolean
  /** A plane, cylinder or sphere exists to measure against. */
  hasTargetElement: boolean
  targetChosen: boolean

  // Wall thickness workspace.
  thicknessReady: boolean

  // 2D Measure workspace. Its first step is an image, not the scan mesh.
  imageLoaded: boolean
}

/** The scan is the first step of every workspace. While it is missing there are
 *  two ways to open one on screen at once — the stage prompt's tile and the
 *  panel's slot — and they are the same action, so both wear the ring. Singling
 *  one out would imply a difference between them that does not exist. */
const OPEN_SCAN: HintStep = {
  target: 'open-scan',
  text: 'Open the scan you want to measure',
}

export function nextHint(m: HintInput): HintResult {
  if (m.busy) return null
  // The flat workspace measures an image, not the scan mesh — its ladder
  // grows with the workspace, and for now only the front door is on it.
  if (m.workspace === 'flat') {
    return m.imageLoaded
      ? null
      : { target: 'open-image', text: 'Open the flatbed scan you want to measure' }
  }
  if (!m.scanLoaded) return OPEN_SCAN
  if (m.workspace === 'deviation') return deviationLadder(m)
  if (m.workspace === 'thickness') {
    return m.thicknessReady
      ? 'done'
      : { target: 'measure-thickness', text: 'Part loaded — measure its wall thickness' }
  }
  return elementsLadder(m)
}

/** Open the scan, fit two elements, measure between them. A dimension is the
 *  result the workspace exists for, so one of those finishes the track — even
 *  a single-element one, which is why it is asked before the element count. */
function elementsLadder(m: HintInput): HintResult {
  // The alignment editor collects points and elements with a running
  // instruction of its own; a second voice over it would only compete.
  if (m.alignDraftOpen) return null
  if (m.dimensions > 0) return 'done'
  if (m.draftOpen) {
    return { target: 'create-element', text: 'Create the element once the fit looks right' }
  }
  if (m.dimDraftOpen) {
    return { target: 'add-dimension', text: 'Add the dimension once both slots are filled' }
  }
  if (m.fittedElements === 0) {
    return {
      target: 'kindrow',
      text: 'Pick a shape to fit on the part — then click that feature on the scan',
    }
  }
  if (m.fittedElements === 1) {
    return {
      target: 'kindrow',
      text: 'One element measured — fit a second one to measure between them',
    }
  }
  return { target: 'new-dimension', text: 'Two elements measured — now measure between them' }
}

/** Two setups behind the same map, and they share only the scan: a reference
 *  part has to be loaded and best-fitted, an element only chosen. */
function deviationLadder(m: HintInput): HintResult {
  if (m.onElement) {
    if (!m.hasTargetElement) {
      return {
        target: 'target-goto-measure',
        text: 'No plane, cylinder or sphere yet — fit one in the 3D Measure workspace',
      }
    }
    if (!m.targetChosen) {
      return { target: 'target-select', text: 'Choose the element to measure against' }
    }
    return 'done'
  }
  if (!m.referenceLoaded) {
    return { target: 'open-reference', text: 'Now open the reference — the nominal part from CAD' }
  }
  if (!m.aligned) {
    return { target: 'align-auto', text: 'Both models loaded — fit the scan onto the reference' }
  }
  if (!m.mapReady) {
    return { target: 'measure-deviation', text: 'Aligned — measure the deviation' }
  }
  return 'done'
}
