// SPDX-License-Identifier: AGPL-3.0-only
// Project fixtures the project-file tests share: a session as a scan just
// loaded leaves it, and the source files a project packs.

import { useStore } from '../src/state/store'
import { useDeviation } from '../src/state/deviationStore'
import { useThickness } from '../src/state/thicknessStore'
import { useFlat } from '../src/state/flatStore'
import { useShell } from '../src/state/shellStore'
import { strToU8 } from 'fflate'

/** The session as a scan just loaded leaves it: the other workspaces empty. */
export function fresh() {
  useStore.getState().beginLoad('bracket.stl')
  useStore.getState().finishLoad(100, 50, 10, [1, 2, 3])
  useDeviation.setState({ nominalName: null, align: null, globalAlign: null, pairs: [], probes: [] })
  useThickness.getState().clear()
  useFlat.setState({ imageName: null, elements: [], dimensions: [], counts: [], datum: null })
  useShell.getState().setWorkspace('elements')
}

/** The source files a project packs beside its manifest. */
export const sources = () => ({
  scan: { name: 'bracket.stl', file: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]) },
  reference: { name: 'bracket.step', file: new Blob([strToU8('ISO-10303-21;')]) },
  image: { name: 'sheet.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
})
