// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the part on the stage is made of and how it is lit — the one place
 * every viewport takes its surface colours and its lights from.
 *
 * Two schemes, and the difference between them is a way of looking rather than
 * a way of measuring: nothing here touches the deviation ramp, the element
 * colours or the unmeasured grey of a map, because those carry readings and a
 * reading must not change colour because the lights did. The stage itself does
 * not change either — it is the instrument's chassis, and the canvas has to go
 * on sitting in it.
 *
 * The default is the instrument's own: a matt grey part, which is the quietest
 * thing to lay a coloured map or an element tint over. The alternative is the
 * one every handheld scanner's own software puts on screen — a glossy blue part
 * under a hard light — because a tight specular highlight travelling over a
 * surface is the best way there is to see the shape of it: tool marks, print
 * layers, the faceting of a coarse mesh and the ripple of a bad scan all show
 * up in the highlight long before they show up in matt shading.
 */
import * as THREE from 'three'
import { UNMEASURED_RGB } from '../core/field/colormap'

export interface ViewTheme {
  id: string
  /** Shown in the status strip's picker. */
  label: string
  /** One line beside it: what this scheme is for. */
  hint: string
  /** The stage behind the parts. The same in both schemes — it matches the
   *  `.stage` chassis grey in the stylesheet, and the canvas has to sit in the
   *  instrument rather than on top of it. */
  stage: number
  /** Bare scan surface: what a vertex is coloured when nothing has been
   *  measured on it and no element owns it. */
  surface: readonly [number, number, number]
  /** The reference part where it is overlaid on the scan. Never the same hue as
   *  the scan there: two parts of very nearly the same shape, in one colour, in
   *  one place read as a single washed-out object.
   *
   *  Views that give each part a frame of its own — the split view, the point
   *  picker — have no such problem and deliberately do not use this: they show
   *  both parts in `surface`, so the only difference on screen is the shape. */
  nominal: number
  /** The far side of a triangle, when back-face tinting is on. Must not be
   *  mistakable for an element colour, a deviation band or bare surface. */
  backface: number
  /** How the surface takes light. Low roughness is the whole point of the
   *  scanner scheme: the highlight is what shows the shape. */
  finish: { roughness: number; metalness: number }
  lights: {
    /** Hemisphere: sky above, bounce below, and its strength. */
    sky: number
    ground: number
    hemisphere: number
    /** Flat fill. Keeping this low is what leaves the shading its contrast. */
    ambient: number
    /** The key, which rides on the camera — so the highlight sits where you
     *  are looking from, and turning the part sweeps it across the surface. */
    key: number
  }
}

/** Chassis grey, matching `.stage` in the stylesheet. */
const STAGE = 0xdedcd6

export const VIEW_THEMES: readonly ViewTheme[] = [
  {
    id: 'studio',
    label: 'Studio grey',
    hint: 'Matt grey part, evenly lit',
    stage: STAGE,
    // The machined-aluminium grey a map's unmeasured patches wear too — the two
    // mean the same thing here, that nothing has been measured on this surface.
    surface: UNMEASURED_RGB,
    nominal: 0x5c86bd,
    backface: 0x9c5b70,
    finish: { roughness: 0.62, metalness: 0.05 },
    lights: { sky: 0xffffff, ground: 0xb9b6ae, hemisphere: 1.0, ambient: 0.35, key: 1.6 },
  },
  {
    id: 'scanner',
    label: 'Scanner blue',
    hint: 'Glossy blue under a hard light — surface detail stands out',
    stage: STAGE,
    // Deeper and duller than the first of the element colours (a saturated
    // #1877c0), which is painted straight onto this surface and has to read as
    // a patch on it. The hard key lifts it back to the scanner blue you know —
    // this is the albedo, not what you see.
    surface: [20, 92, 141],
    // Amber, not the studio's blue: here the scan itself is blue, and the point
    // of the reference's colour is that it is not the scan's.
    nominal: 0xdd9a3f,
    backface: 0xc0687e,
    // Glossy enough for a tight highlight, with just enough metalness to keep
    // the unlit side from going flat — but no further: the deviation ramp is
    // painted onto this same surface, and a mirror would blow its colours out.
    finish: { roughness: 0.3, metalness: 0.16 },
    // A hard key against very little fill: it is the difference between the lit
    // and the unlit side that gives a surface its form, and a bright fill would
    // flatten out exactly the shallow detail this scheme exists to show.
    lights: { sky: 0xa6c9ea, ground: 0x2c3238, hemisphere: 0.42, ambient: 0.08, key: 2.6 },
  },
]

export const DEFAULT_THEME = VIEW_THEMES[0]

/** Falls back to the default, so a stale id in localStorage cannot leave the
 *  stage unlit. */
export function themeById(id: string | null | undefined): ViewTheme {
  return VIEW_THEMES.find((t) => t.id === id) ?? DEFAULT_THEME
}

/** Dress a part in the scheme's finish. The scan, the reference and the parts
 *  in the split picker all take the same one: they are the same material seen
 *  under the same lights, and only their colour says which is which. */
export function applyFinish(material: THREE.MeshStandardMaterial, theme: ViewTheme): void {
  material.roughness = theme.finish.roughness
  material.metalness = theme.finish.metalness
}

/**
 * Paint a whole part in the scheme's bare-surface colour — the flat-colour
 * equivalent of what the vertex-colour compositor writes on the scan, for the
 * views that show a part with no map on it (the split view's reference half, both
 * halves of the point picker).
 *
 * Written straight into the working colour space rather than through setHex, and
 * that is not a detail: three.js colour-manages `material.color` — a hex word is
 * taken as sRGB and converted — but hands vertex colours to the shader untouched.
 * The same bytes down the two paths therefore land a whole gamma apart, which on
 * screen is a reference half visibly darker than the scan beside it. Declaring
 * them linear is what makes one flat part and one vertex-coloured part the same
 * shade of the same material.
 */
export function setSurfaceColor(color: THREE.Color, theme: ViewTheme): void {
  const [r, g, b] = theme.surface
  color.setRGB(r / 255, g / 255, b / 255, THREE.LinearSRGBColorSpace)
}
