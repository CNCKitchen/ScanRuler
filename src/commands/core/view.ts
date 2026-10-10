// SPDX-License-Identifier: AGPL-3.0-only
// The viewport: which way the part is looked at, what is shown in it, and a
// picture of it — how an agent that cannot see the screen sees what is on
// it, and sees the model on its own when the scan over it is in the way.
// Neither changes the session: the camera and what is shown are no part of
// a project and no step of the history. Both need the viewport, and wait
// for the session to settle and the viewport to draw it first — what a
// workspace puts on the stage follows its stores a frame or two behind.

import { exportStem } from '../../app/exports'
import type { Vec3 } from '../../core/types'
import { useDeviation } from '../../state/deviationStore'
import { useShell } from '../../state/shellStore'
import { useStore } from '../../state/store'
import type { StandardView } from '../../viewer/orthoViewport'
import type { SceneManager } from '../../viewer/SceneManager'
import { requireScene, sceneOf, sessionBusy } from '../host'
import { bool, enumOf, int, num, obj, oneOf, vec3, type JsonSchema } from '../schema'
import { CommandError, type Command } from '../types'
import { pluginToggleKeys, viewToggles, type ViewToggle } from '../viewToggles'
import { waitFor } from './common'

const VIEWS: readonly StandardView[] = ['iso', 'top', 'bottom', 'front', 'rear', 'left', 'right']

/** The longest side of a picture, pixels, when none is asked for: enough
 *  to check a step by. An agent pays for a picture by its pixels — one
 *  1280 across costs it two and a half of these — so a larger one is for
 *  a picture to keep, and asked for. */
const DEFAULT_LONG_SIDE = 800
const MAX_SIDE = 2048

const viewSchema = enumOf(
  VIEWS,
  'A standard view, the camera turned about the middle of the screen: iso (from the front, right and above), top (down the Z axis, Y up the screen), bottom, front (from −Y, Z up), rear (from +Y), left (from −X), right (from +X).',
)
const fitSchema = bool('Bring everything shown into the frame, keeping the direction looked from.')

// ---- what is shown ----------------------------------------------------------------

/** The app's own toggles: what the scene draws of the session. The scan
 *  and the reference go through the Deviation workspace's own switches
 *  while it is on screen, so its effects do not put them straight back. */
function baseToggles(scene: SceneManager): ViewToggle[] {
  const onDeviation = () => useShell.getState().workspace === 'deviation'
  return [
    {
      key: 'scan',
      description: 'the scan',
      shown: () => (onDeviation() ? useDeviation.getState().showScan : scene.scanShown()),
      show: (on) => (onDeviation() ? useDeviation.getState().setShowScan(on) : scene.setScanVisible(on)),
    },
    {
      key: 'reference',
      description: 'the reference part of the Deviation workspace',
      shown: () => (onDeviation() ? useDeviation.getState().showNominal : scene.nominalShown()),
      show: (on) => (onDeviation() ? useDeviation.getState().setShowNominal(on) : scene.setNominalVisible(on)),
    },
    { key: 'sections', description: 'the sections cut through the scan', shown: () => scene.sectionsShown(), show: (on) => scene.setSectionsShown(on) },
    { key: 'elements', description: 'the measured elements and dimensions drawn on the part', shown: () => scene.elementsShown(), show: (on) => scene.setElementsShown(on) },
    { key: 'labels', description: 'the name tags and readouts over the part', shown: () => scene.labelsShown(), show: (on) => scene.setLabelsVisible(on) },
  ]
}

const BASE_KEYS = ['scan', 'reference', 'sections', 'elements', 'labels']

const showSchema = (): JsonSchema => ({
  type: 'object',
  description:
    'What to show or put away, by key, true or false: scan, reference (the Deviation workspace’s reference part), sections, elements (the measured elements and dimensions), labels — and the keys a workspace adds (view.set answers with every key standing now and whether it is shown). { scan: false } pictures what was built on the scan on its own.',
  properties: Object.fromEntries(BASE_KEYS.map((k) => [k, bool()])),
})

const frameSchema = oneOf(
  [
    obj({ min: vec3('The lowest corner, mm.'), max: vec3('The highest corner, mm.') }, ['min', 'max'], 'A box, in the frame the part is measured in now.'),
    obj({ at: vec3('The centre, mm.'), size: num('The width of the view there, mm.', { exclusiveMinimum: 0 }) }, ['at', 'size'], 'A place, looked at from `size` mm across.'),
  ],
  'Frame a box or a place instead of everything shown — a corner or a fillet looked at closely; fit is then left alone.',
)

type Frame = { min: Vec3; max: Vec3 } | { at: Vec3; size: number }

/** Every toggle standing now, by key. */
const toggles = (scene: SceneManager) => viewToggles(baseToggles(scene))

/** What each toggle shows now. */
const shownNow = (scene: SceneManager): Record<string, boolean> => Object.fromEntries([...toggles(scene)].map(([k, t]) => [k, t.shown()]))

/** Set the toggles as asked, refusing a key none stands under. Returns
 *  what to set to put them back. */
function applyShow(scene: SceneManager, show: Record<string, boolean> | undefined): Record<string, boolean> {
  if (!show) return {}
  const all = toggles(scene)
  const before: Record<string, boolean> = {}
  for (const [key, on] of Object.entries(show)) {
    const t = all.get(key)
    if (!t) {
      const known = [...all.keys()].join(', ')
      const elsewhere = pluginToggleKeys().find((p) => p.key === key)
      throw new CommandError('invalid_input', elsewhere ? `show.${key}: not on screen in this workspace — it is ${elsewhere.description}; the keys standing now are ${known}.` : `show.${key}: no such key — there are ${known}.`)
    }
    if (typeof on !== 'boolean') throw new CommandError('invalid_input', `show.${key}: expected true or false`)
    before[key] = t.shown()
    t.show(on)
  }
  return before
}

function aimAt(scene: SceneManager, frame: Frame | undefined): void {
  if (!frame) return
  if ('at' in frame) {
    const h = frame.size / 2
    scene.fitBox([frame.at[0] - h, frame.at[1] - h, frame.at[2] - h], [frame.at[0] + h, frame.at[1] + h, frame.at[2] + h])
  } else {
    for (let k = 0; k < 3; k++) if (!(frame.min[k] <= frame.max[k])) throw new CommandError('invalid_input', 'frame: min lies past max.')
    scene.fitBox(frame.min, frame.max)
  }
}

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

/** Turn and fit as asked — a fit alone when nothing is, and no fit where a
 *  frame is asked for instead. */
function aim(scene: SceneManager, view: StandardView | undefined, fit: boolean | undefined, frame: Frame | undefined): void {
  if (view) scene.viewFrom(view)
  if (frame) aimAt(scene, frame)
  else if (fit ?? !view) scene.fitToView()
}

/** What the toggles were set to, then the frames the stage takes to follow
 *  — a toggle that goes through a store is drawn by the workspace's next
 *  effect, not at once. */
async function shown(scene: SceneManager, show: Record<string, boolean> | undefined): Promise<Record<string, boolean>> {
  const before = applyShow(scene, show)
  if (show) for (let i = 0; i < 3; i++) await nextFrame()
  return before
}

const set: Command<{ view?: StandardView; fit?: boolean; show?: Record<string, boolean>; frame?: Frame }> = {
  name: 'set',
  title: 'Turn the view',
  description:
    'Turn the 3D view to a standard view and/or fit everything shown into the frame — with neither given, it fits — or frame a box or a place (frame). show puts the scan, the reference, the sections, the elements or the labels on screen or away, by key, and leaves them so — { scan: false } to look at what was built on the scan without it. It waits for the session to settle first (a fit, a map, a rebuild), so what was just made is in the frame. Not a step of the history. Needs the viewport. Returns the view and, under shown, every key that can be shown now and whether it is.',
  input: obj({ view: viewSchema, fit: fitSchema, show: showSchema(), frame: frameSchema }),
  readOnly: true,
  run: async ({ view, fit, show, frame }) => {
    const scene = await settledScene('Turning the view')
    await shown(scene, show)
    aim(scene, view, fit, frame)
    await nextFrame()
    return { view: view ?? null, fitted: frame ? false : (fit ?? !view), ...(frame ? { framed: frame } : {}), size: scene.viewSize(), shown: shownNow(scene) }
  },
}

const render: Command<{ width?: number; height?: number; view?: StandardView; fit?: boolean; show?: Record<string, boolean>; frame?: Frame }> = {
  name: 'render',
  title: 'Picture the view',
  description:
    'A picture of the 3D view as a PNG — what the person sees in the viewport, without the HTML labels over it (dimension values, names). Give view and/or fit to turn the view first, as view.set does, or frame to frame a box or a place. show puts the scan, the reference, the sections, the elements or the labels on screen or away for the picture alone, by key — { scan: false } pictures what was built on the scan on its own; view.set lists the keys. width and height in pixels: the viewport’s own shape at most 800 pixels on its long side by default, enough to check a step by — ask for more (up to 2048) for a picture to keep; one of them alone keeps the viewport’s shape. Waits for the session to settle first. Needs the viewport.',
  input: obj({
    width: int('Pixels across, 64 to 2048.', { minimum: 64, maximum: MAX_SIDE }),
    height: int('Pixels down, 64 to 2048.', { minimum: 64, maximum: MAX_SIDE }),
    view: viewSchema,
    fit: fitSchema,
    show: showSchema(),
    frame: frameSchema,
  }),
  readOnly: true,
  returnsFile: true,
  returnsImage: true,
  run: async ({ width, height, view, fit, show, frame }) => {
    const scene = await settledScene('A picture of the view')
    const before = await shown(scene, show)
    try {
      if (view || fit || frame) {
        aim(scene, view, fit, frame)
        await nextFrame()
      }
      return await picture(scene, width, height, view, show)
    } finally {
      // What was put away for the picture comes back; the frame stays.
      if (Object.keys(before).length > 0) {
        applyShow(scene, before)
        await nextFrame()
      }
    }
  },
}

/** The picture itself: the viewport's shape at the size asked for. */
async function picture(scene: SceneManager, width: number | undefined, height: number | undefined, view: StandardView | undefined, show: Record<string, boolean> | undefined) {
  const size = scene.viewSize()
  const aspect = size.width / size.height
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
  return { file: { name: `${stem}-view.png`, mimeType: 'image/png', bytes }, width: w, height: h, view: view ?? null, ...(show ? { shown: shownNow(scene) } : {}) }
}

/** The toggles standing now and whether each is shown — for the readout,
 *  null without a viewport. */
export function describeView(): Record<string, boolean> | null {
  const scene = sceneOf()
  return scene ? shownNow(scene) : null
}

export const viewCommands = [set, render]
