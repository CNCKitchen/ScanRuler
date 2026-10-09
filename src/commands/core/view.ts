// SPDX-License-Identifier: AGPL-3.0-only
// The viewport: which way the part is looked at, and a picture of it — how
// an agent that cannot see the screen sees what is on it. Neither changes
// the session: the camera is no part of a project and no step of the
// history. Both need the viewport, and wait for the session to settle and
// the viewport to draw it first — what a workspace puts on the stage
// follows its stores a frame or two behind.

import { exportStem } from '../../app/exports'
import { useStore } from '../../state/store'
import type { StandardView } from '../../viewer/orthoViewport'
import type { SceneManager } from '../../viewer/SceneManager'
import { requireScene, sessionBusy } from '../host'
import { bool, enumOf, int, obj } from '../schema'
import type { Command } from '../types'
import { waitFor } from './common'

const VIEWS: readonly StandardView[] = ['iso', 'top', 'bottom', 'front', 'rear', 'left', 'right']

/** The longest side of a picture, pixels, when none is asked for. */
const DEFAULT_LONG_SIDE = 1280
const MAX_SIDE = 2048

const viewSchema = enumOf(
  VIEWS,
  'A standard view, the camera turned about the middle of the screen: iso (from the front, right and above), top (down the Z axis, Y up the screen), bottom, front (from −Y, Z up), rear (from +Y), left (from −X), right (from +X).',
)
const fitSchema = bool('Bring everything shown into the frame, keeping the direction looked from.')

const nextFrame = () =>
  new Promise<void>((resolve) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, 16)))

/** The viewport once the session has settled and the stage has caught up
 *  with the stores. */
async function settledScene(what: string): Promise<SceneManager> {
  const scene = requireScene(what)
  await waitFor(() => sessionBusy() === null, 'the session to settle', 120_000)
  for (let i = 0; i < 3; i++) await nextFrame()
  return scene
}

/** Turn and fit as asked — a fit alone when nothing is. */
function aim(scene: SceneManager, view: StandardView | undefined, fit: boolean | undefined): void {
  if (view) scene.viewFrom(view)
  if (fit ?? !view) scene.fitToView()
}

const set: Command<{ view?: StandardView; fit?: boolean }> = {
  name: 'set',
  title: 'Turn the view',
  description:
    'Turn the 3D view to a standard view and/or fit everything shown into the frame — with neither given, it fits. It waits for the session to settle first (a fit, a map, a rebuild), so what was just made is in the frame. Not a step of the history. Needs the viewport. Returns the view.',
  input: obj({ view: viewSchema, fit: fitSchema }),
  readOnly: true,
  run: async ({ view, fit }) => {
    const scene = await settledScene('Turning the view')
    aim(scene, view, fit)
    await nextFrame()
    return { view: view ?? null, fitted: fit ?? !view, size: scene.viewSize() }
  },
}

const render: Command<{ width?: number; height?: number; view?: StandardView; fit?: boolean }> = {
  name: 'render',
  title: 'Picture the view',
  description:
    'A picture of the 3D view as a PNG — what the person sees in the viewport, without the HTML labels over it (dimension values, names). Give view and/or fit to turn the view first, as view.set does. width and height in pixels: the viewport’s own shape at most 1280 pixels on its long side by default; one of them alone keeps the viewport’s shape. Waits for the session to settle first. Needs the viewport.',
  input: obj({
    width: int('Pixels across, 64 to 2048.', { minimum: 64, maximum: MAX_SIDE }),
    height: int('Pixels down, 64 to 2048.', { minimum: 64, maximum: MAX_SIDE }),
    view: viewSchema,
    fit: fitSchema,
  }),
  readOnly: true,
  returnsFile: true,
  returnsImage: true,
  run: async ({ width, height, view, fit }) => {
    const scene = await settledScene('A picture of the view')
    if (view || fit) {
      aim(scene, view, fit)
      await nextFrame()
    }
    const shown = scene.viewSize()
    const aspect = shown.width / shown.height
    const fitIn = (w: number, h: number) => [Math.max(64, Math.min(MAX_SIDE, Math.round(w))), Math.max(64, Math.min(MAX_SIDE, Math.round(h)))]
    const [w, h] =
      width && height
        ? [width, height]
        : width
          ? fitIn(width, width / aspect)
          : height
            ? fitIn(height * aspect, height)
            : fitIn(...((aspect >= 1 ? [DEFAULT_LONG_SIDE, DEFAULT_LONG_SIDE / aspect] : [DEFAULT_LONG_SIDE * aspect, DEFAULT_LONG_SIDE]) as [number, number]))
    const bytes = await scene.capture(w, h)
    const stem = useStore.getState().fileName ? exportStem() : 'scanruler'
    return { file: { name: `${stem}-view.png`, mimeType: 'image/png', bytes }, width: w, height: h, view: view ?? null }
  },
}

export const viewCommands = [set, render]
