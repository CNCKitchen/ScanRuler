// SPDX-License-Identifier: AGPL-3.0-only
// The 2D Measure workspace's state: the loaded scan image and what is known
// about its scale. The decoded bitmap itself lives in a ref owned by App —
// the same rule that keeps meshes and fields out of the other stores — and
// `imageVersion` is how everyone else learns a new one has landed.

import { create } from 'zustand'
import type { PixelsPerMm } from '../core/flat/image'

interface FlatState {
  imageName: string | null
  /** Pixel dimensions of the loaded image. */
  imageWidth: number
  imageHeight: number
  imageBusy: boolean
  /** Bumped when a fresh bitmap has landed in App's ref. */
  imageVersion: number
  /** Pixels per mm as declared by the file's metadata, or null when the file
   *  carried none — then the sheet is shown at one pixel per millimetre and
   *  every number on it is pixels until a calibration says otherwise. */
  metaPxPerMm: PixelsPerMm | null

  beginImageLoad: (name: string) => void
  finishImageLoad: (name: string, width: number, height: number, meta: PixelsPerMm | null) => void
  imageFailed: () => void
}

export const useFlat = create<FlatState>()((set) => ({
  imageName: null,
  imageWidth: 0,
  imageHeight: 0,
  imageBusy: false,
  imageVersion: 0,
  metaPxPerMm: null,

  beginImageLoad: (imageName) => set({ imageBusy: true, imageName }),

  finishImageLoad: (imageName, imageWidth, imageHeight, metaPxPerMm) =>
    set((s) => ({
      imageBusy: false,
      imageName,
      imageWidth,
      imageHeight,
      metaPxPerMm,
      imageVersion: s.imageVersion + 1,
    })),

  imageFailed: () =>
    set({ imageBusy: false, imageName: null, imageWidth: 0, imageHeight: 0, metaPxPerMm: null }),
}))
