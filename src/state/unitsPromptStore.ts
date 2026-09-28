// SPDX-License-Identifier: AGPL-3.0-only
// The question an STL import asks: what units are its coordinates in? The
// format carries none, and a part read at the wrong scale measures wrong in
// every number after. The question is a promise the import awaits before it
// reads the file, answered by the units window (ui/UnitsModal); one file is
// asked about at a time, a second dropped meanwhile waits its turn. The
// answer is remembered as what the question offers first next time, and with
// "Don't ask again" it stands in for the question until the settings window
// brings it back — both preferences, see prefsStore.

import { create } from 'zustand'
import { extensionOf } from '../core/formats'
import type { MeshUnits } from '../core/meshUnits'
import { usePrefs } from './prefsStore'

interface UnitsPromptState {
  /** The file waiting on an answer, or null while no question is open. */
  request: { fileName: string } | null
  /** The operator's answer; with `remember`, every STL from here on. */
  answer: (units: MeshUnits, remember: boolean) => void
  /** The question dismissed: the file is not opened. */
  cancel: () => void
}

let pending: ((units: MeshUnits | null) => void) | null = null
let chain: Promise<unknown> = Promise.resolve()

export const useUnitsPrompt = create<UnitsPromptState>()((set) => ({
  request: null,
  answer: (units, remember) => {
    const prefs = usePrefs.getState()
    prefs.setStlUnits(units)
    if (remember) prefs.setAskStlUnits(false)
    const resolve = pending
    pending = null
    set({ request: null })
    resolve?.(units)
  },
  cancel: () => {
    const resolve = pending
    pending = null
    set({ request: null })
    resolve?.(null)
  },
}))

/** Put the question to the operator for this file. Resolves with the answer,
 *  or null when the question was dismissed. */
export function askMeshUnits(fileName: string): Promise<MeshUnits | null> {
  const ask = () =>
    new Promise<MeshUnits | null>((resolve) => {
      pending = resolve
      useUnitsPrompt.setState({ request: { fileName } })
    })
  const result = chain.then(ask)
  chain = result.then(() => {}, () => {})
  return result
}

/** The units to read a mesh file in: millimetres for anything but an STL,
 *  and for an STL the remembered answer, or the operator's — null when they
 *  dismissed the question, and the file is not to be opened. */
export function meshUnitsFor(fileName: string): Promise<MeshUnits | null> {
  if (extensionOf(fileName) !== 'stl') return Promise.resolve('mm')
  const prefs = usePrefs.getState()
  if (!prefs.askStlUnits) return Promise.resolve(prefs.stlUnits)
  return askMeshUnits(fileName)
}
