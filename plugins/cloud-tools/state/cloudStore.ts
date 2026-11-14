// SPDX-License-Identifier: AGPL-3.0-only
// Everything the Cloud Tools workspace knows: the tool in hand, its
// settings, and what it found. What is marked to go is the scene's marking
// (the app's one), read when it is deleted.

import { create } from 'zustand'
import type { FloatingSurvey } from '../core/clean'

/** How points are marked to go: the pieces floating off the main body, the
 *  points past a plane, or by hand. */
export type CloudTool = 'floating' | 'plane' | 'hand'

export type PlaneAxis = 0 | 1 | 2

/** What Floating pieces found, less the points themselves (the marking holds them). */
export type FloatingCount = Omit<FloatingSurvey, 'vertices'> & { percent: number; points: number }

interface CloudToolsState {
  tool: CloudTool | null
  /** A piece smaller than this share of the main body floats, %. */
  percent: number
  axis: PlaneAxis
  /** Where the plane crosses its axis in the frame shown, mm — null for the
   *  middle of the part. */
  offset: number | null
  /** The side of the plane whose points go: +1 past it along the axis, -1 before. */
  side: 1 | -1
  floating: FloatingCount | null
  /** What a step in progress is doing, or null. */
  running: string | null
  confirming: boolean

  setTool(tool: CloudTool | null): void
  setPercent(percent: number): void
  setAxis(axis: PlaneAxis): void
  setOffset(offset: number | null): void
  setSide(side: 1 | -1): void
  setFloating(floating: FloatingCount | null): void
  setRunning(running: string | null): void
  setConfirming(confirming: boolean): void
}

/** What Floating pieces starts at. The specks a hand scanner leaves are a
 *  few hundredths of a percent of the part; a partial pass can leave real
 *  pieces of the part cut off by gaps in it — a gear's teeth at 4 to 9 % of
 *  the main body on one RevoMetro pass — so it starts well below those. */
export const DEFAULT_PERCENT = 1

export const useCloudTools = create<CloudToolsState>((set) => ({
  tool: null,
  percent: DEFAULT_PERCENT,
  axis: 2,
  offset: null,
  side: -1,
  floating: null,
  running: null,
  confirming: false,

  setTool: (tool) => set({ tool, confirming: false }),
  setPercent: (percent) => set({ percent: Math.min(Math.max(Number.isFinite(percent) ? percent : 0, 0), 100) }),
  setAxis: (axis) => set({ axis }),
  setOffset: (offset) => set({ offset }),
  setSide: (side) => set({ side }),
  setFloating: (floating) => set({ floating }),
  setRunning: (running) => set({ running }),
  setConfirming: (confirming) => set({ confirming }),
}))
