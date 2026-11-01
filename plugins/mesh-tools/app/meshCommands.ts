// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools workspace's commands — what an agent cleans a scan up,
// edits it and reduces it through (src/commands), registered from the
// plugin's install() under `mesh`, the workspace's id: mesh.cut,
// mesh.fill_holes and the rest. Each is the panel's own code path: the
// tool put in hand, its settings set through the store as the panel's
// fields set them, and the verb the panel's button runs
// (meshToolsSession.ts) run inside one step of the undo history
// ("Agent: …"), awaited, and what came of it handed back. A command that
// fails leaves the settings as they were, and no step.

import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import { useMark } from '../../../src/state/markStore'
import { historyAsync, historyBlocked, pick } from '../../../src/state/historyStore'
import { CommandError, type Command } from '../../../src/plugins/api'
import { arr, bool, enumOf, int, num, obj, oneOf, str, vec3, type JsonSchema } from '../../../src/commands/schema'
import { findElement, parsePlaneName, requireScan } from '../../../src/commands/refs'
import { requireScene, sceneOf } from '../../../src/commands/host'
import { invalid, lastError, nextFrame, requireFlatFree, requireMeasureFree } from '../../../src/commands/core/common'
import { cutAxisOf, type SectionRef } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import { offeredSolids, type OfferedSolid } from '../../../src/app/solids'
import type { BuiltFile } from '../../../src/app/exports'
import { meshToolsOf } from '../core/meshClient'
import { cutPlaneOf } from '../core/cutPlane'
import { summarizeCopyDeviation } from '../core/edit'
import type { BooleanOp } from '../core/boolean'
import type { FillMode } from '../core/fillHoles'
import type { ThickenSide } from '../core/offset'
import { DEFAULT_FACING_DEG } from '../core/select'
import {
  DELETE_MARK_COLOR,
  FLIP_MARK_COLOR,
  MESH_SETTINGS,
  OFFSET_MARK_COLOR,
  SMOOTH_MARK_COLOR,
  shellModeOf,
  useMeshTools,
  type CutKeep,
  type MeshTool,
  type OffsetDirection,
} from '../state/meshStore'
import { editedCopy } from '../state/editedCopy'
import { booleanSolids } from './booleanSolids'
import { buildEditedMesh } from './exportEdited'
import { buildReducedMesh } from './exportReduced'
import { buildTrimmedMesh } from './exportTrimmed'
import { MESH_FORMATS, type MeshFormat } from '../../../src/core/exportMesh'
import { editOut, partsOut, pieceOut, pointOut, reductionOut } from './meshReadout'
import { meshToolsSession, type EditLanded, type MeshToolsSession } from './meshToolsSession'
import { errorMessage } from '../../../src/commands/types'

type Ref = number | string
type Json = Record<string, unknown>

const m = () => useMeshTools.getState()

// ---- the session ---------------------------------------------------------------------

function session(): MeshToolsSession {
  const s = meshToolsSession()
  if (!s) throw new CommandError('unavailable', 'The Mesh Tools workspace is not set up in this session.')
  return s
}

const client = () => {
  const c = session().clientRef.current
  if (!c) throw new CommandError('unavailable', 'The mesh worker is not running.')
  return meshToolsOf(c)
}

/** The workspace on screen with `tool` in hand, as its key puts it there. */
function inHand(tool: MeshTool | null): void {
  if (useShell.getState().workspace !== 'mesh') useShell.getState().setWorkspace('mesh')
  if (m().tool !== tool) m().setTool(tool)
}

/** A frame or two for the screen to follow the stores — a tool put in hand
 *  clears the marking of the one before it once it is drawn. */
const frames = async (n = 2): Promise<void> => {
  // The browser's frames — or, in a hidden tab that draws none, frames
  // drawn by hand (nextFrame).
  for (let i = 0; i < n; i++) await nextFrame(sceneOf())
}

/**
 * Run `job` as one step of the undo history, "Agent: `label`". With
 * `guard`, refused first wherever the panel's own button would be: while a
 * panel has work open that the mesh cannot change under. A job that comes
 * back null failed — the session said why — and the settings go back to
 * what they were, which leaves no step.
 */
async function step<T>(label: string, what: string, job: () => Promise<T | null>, guard: boolean): Promise<T> {
  requireScan()
  if (guard) {
    requireMeasureFree()
    requireFlatFree()
    if (historyBlocked()) {
      throw new CommandError(
        'invalid_state',
        'A panel has work open that the mesh cannot change under — finish or cancel it there first, or ask the person at the screen to.',
      )
    }
  }
  const before = pick(m(), [...MESH_SETTINGS])
  useStore.setState({ errorText: null })
  let out: T | null = null
  await historyAsync(`Agent: ${label}`, async () => {
    try {
      out = await job()
    } finally {
      if (out === null) useMeshTools.setState(before)
    }
  })
  if (out === null) throw new CommandError('failed', lastError(`${what} did not go through.`))
  return out
}

// ---- regions -------------------------------------------------------------------------

type RegionIn =
  | 'marked'
  | { box?: { min: Vec3; max: Vec3 }; sphere?: { center: Vec3; radius: number }; vertices?: number[]; facing?: Vec3; angleDeg?: number }

const regionSchema = (what: string): JsonSchema =>
  oneOf(
    [
      enumOf(['marked'], '"marked": the surface marked on the part now — by the person at the screen with the window, brush or lasso, or by mesh.mark. Needs the viewport.'),
      obj(
        {
          box: obj({ min: vec3('The low corner, mm.'), max: vec3('The high corner, mm.') }, ['min', 'max'], 'The vertices inside an axis-aligned box, its sides included.'),
          sphere: obj({ center: vec3('The centre, mm.'), radius: num('mm.', { exclusiveMinimum: 0 }) }, ['center', 'radius'], 'The vertices within a radius of a point.'),
          vertices: arr(int(undefined, { minimum: 0, maximum: 0xffffffff }), 'The vertices by number — the edited copy’s while there is one, else the scan’s.', { minItems: 1 }),
          facing: vec3('Of those, only the vertices whose normal points within angleDeg of this direction — [0, 0, 1] for the faces looking up. Narrows a box to one face of the part.'),
          angleDeg: num(`How far a normal may turn from facing and still face it, degrees — ${DEFAULT_FACING_DEG} to start.`, { exclusiveMinimum: 0, maximum: 180 }),
        },
        [],
        'Exactly one of box, sphere or vertices, with facing and angleDeg to narrow it. Coordinates are mm in the frame the part is measured in now (session.state gives the scan’s bounds).',
      ),
    ],
    what,
  )

/** The vertices a region holds, of the mesh the workspace works on. */
async function regionVertices(region: RegionIn): Promise<Uint32Array> {
  if (region === 'marked') {
    const vertices = requireScene('A region marked on the part').paintedVertices()
    if (vertices.length === 0) {
      throw new CommandError('invalid_state', 'Nothing is marked on the part — mark it with mesh.mark, or name the region with a box, a sphere or vertices.')
    }
    return vertices
  }
  const shapes = (['box', 'sphere', 'vertices'] as const).filter((k) => region[k] !== undefined)
  if (shapes.length !== 1) invalid('Name the region one way: a box, a sphere or vertices — with facing and angleDeg to narrow it.')
  // A number past 32 bits would wrap round to another vertex when made a
  // Uint32Array, out of reach of the worker's own check that it is one.
  const tooBig = region.vertices?.find((v) => !(v >= 0 && v <= 0xffffffff))
  if (tooBig !== undefined) invalid(`The mesh has no vertex ${tooBig}.`)
  let found: { vertices: Uint32Array; vertexCount: number }
  try {
    found = await client().select({
      ...(region.box ? { box: region.box } : {}),
      ...(region.sphere ? { sphere: region.sphere } : {}),
      ...(region.vertices ? { vertices: Uint32Array.from(region.vertices) } : {}),
      ...(region.facing ? { facing: region.facing } : {}),
      ...(region.angleDeg !== undefined ? { angleDeg: region.angleDeg } : {}),
    })
  } catch (e) {
    return invalid(errorMessage(e))
  }
  if (found.vertices.length === 0) {
    invalid(`The region holds no vertex of the ${m().copyTriangles !== null ? 'edited copy' : 'scan'}${region.facing ? ' facing that way' : ''} — session.state gives the scan’s bounds.`)
  }
  return found.vertices
}

// ---- references ------------------------------------------------------------------------

/** A solid on offer by its key or its name — whole, case aside. */
function solidNamed(ref: string, among: readonly OfferedSolid[] = booleanSolids()): OfferedSolid {
  const byKey = among.find((s) => s.key === ref)
  if (byKey) return byKey
  const want = ref.trim().toLowerCase()
  const hits = among.filter((s) => s.name.trim().toLowerCase() === want)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) invalid(`${hits.length} solids are named "${ref}" — name it by its key: ${hits.map((h) => h.key).join(', ')}.`)
  throw new CommandError(
    'not_found',
    among.length > 0
      ? `No solid on offer is named "${ref}". On offer: ${among.map((s) => `${s.name} (${s.key})`).join(', ')}.`
      : `No solid is on offer — fit a cylinder, cone or sphere in 3D Measure, or model a body in the Reverse engineer workspace.`,
  )
}

/** A plane to cut across: a coordinate plane by name, or an element with a
 *  direction by id or name. */
function cutRefOf(plane: Ref): SectionRef {
  const axis = typeof plane === 'string' ? parsePlaneName(plane) : null
  if (axis) return axis
  const el = findElement(plane)
  if (!el.fit || !cutAxisOf(el.fit)) invalid(`${el.name} has no direction to cut across — take a plane, a cylinder, a cone, a line or a circle.`)
  return el.id
}

const planeSchema = oneOf(
  [
    str('A coordinate plane — "XY", "YZ" or "XZ" — or an element’s name.', { minLength: 1 }),
    int('An element’s id.', { minimum: 1 }),
  ],
  'What to cut across: a coordinate plane — after a datum alignment, the datum’s — or an element with a direction (a plane’s normal, a cylinder’s, cone’s or line’s axis, a circle’s normal).',
)
const offsetSchema = num(
  'Where the plane lies, mm: for a coordinate plane its coordinate along the axis square to it (Z for XY — 0.5 is half a millimetre above the face a datum alignment set the part on); for an element, how far along its direction from it.',
)
const keepSchema = enumOf(
  ['plus', 'minus'] as CutKeep[],
  'Which side stays: plus the side the plane’s direction points to — above XY (Z past the offset), +X of YZ, +Y of XZ, along an element’s direction — minus the other.',
)

/** The plane a cut would be taken at, or a refusal. */
function planeAt(ref: SectionRef, offset: number, keep: CutKeep) {
  const s = useStore.getState()
  const plane = cutPlaneOf(ref, offset, false, keep, s.elements, s.modelCenter)
  if (!plane) invalid('That plane cannot be placed — its element has no direction.')
  return plane!
}

// ---- answers ----------------------------------------------------------------------------

/** What the worker said of an edit, without its tag. */
function reportOut(report: EditLanded['report']): Json {
  const { kind: _kind, ...rest } = report as Json & { kind: string }
  void _kind
  return ('report' in rest ? rest.report : 'survey' in rest ? rest.survey : rest) as Json
}

/** The mesh the workspace works on in figures — its triangles, bounds,
 *  closedness and volume — and the edits on it. */
async function meshOut(): Promise<Json> {
  const copy = m().copyTriangles !== null
  const figures = await client().describe()
  return {
    working: copy ? 'edited copy' : 'scan',
    ...figures,
    edits: (copy ? m().pending : m().edits).map((e) => editOut(e).text),
  }
}

/** An edit that landed, as a command answers it. */
async function editAnswer(landed: EditLanded): Promise<Json> {
  return { edit: editOut(landed.edit), status: landed.status, report: reportOut(landed.report), mesh: await meshOut() }
}

const sizeIn = (what: string) => num(what, { exclusiveMinimum: 0 })
const noInput = obj({})

// ---- reading the mesh -----------------------------------------------------------------

const parts: Command = {
  name: 'parts',
  title: 'List the parts',
  description:
    'What is in the Mesh Tools workspace: the scan (its edits taken into use), the edited copy the tools work on and the edits waiting on it, the reduced mesh and the piece Trim to scan made with their figures, the solids on offer to mesh.boolean and mesh.trim by key and name, and what the parts list shows. Changes nothing.',
  input: noInput,
  readOnly: true,
  run: async () => partsOut(),
}

const show: Command<{ scan?: boolean; reduced?: boolean; piece?: boolean; bodies?: string[]; deviation?: boolean }> = {
  name: 'show',
  title: 'Show or hide parts',
  description:
    'Say what the viewport shows, as the parts list’s eyes do — for a view.render picture of it. Puts Mesh Tools on screen (from whatever workspace was) and the tool in hand away, so the list says what is shown: view.render then pictures these parts — the scan or its edited copy, the reduced mesh, the piece, the lent bodies see-through — and not another workspace’s view, until workspace.set puts that one back (the answer’s back says which). The scan and the reduced mesh lie on one surface and are shown one at a time: showing one hides the other. bodies are the bodies other workspaces lend, by key or name, drawn see-through — the list given is all that is shown. deviation colours the edited copy by its signed distance from the scan in use. Not a step of the history. Returns what is shown, workspace (mesh), and when it changed the screen, back: the workspace it took the place of.',
  input: obj({
    scan: bool('The scan — the edited copy in its place, while there is one.'),
    reduced: bool('The reduced mesh.'),
    piece: bool('The piece Trim to scan made.'),
    bodies: arr(str(undefined, { minLength: 1 }), 'The bodies to show, by key or name; [] for none.'),
    deviation: bool('Colour the edited copy by how far it is from the scan in use, grey where an edit made surface the scan never had.'),
  }),
  readOnly: true,
  run: async ({ scan, reduced, piece, bodies, deviation }) => {
    const lent = offeredSolids()
    const keys = bodies?.map((b) => solidNamed(b, lent).key)
    if (deviation && m().copyTriangles === null) throw new CommandError('invalid_state', 'There is no edited copy to colour — the first edit makes one.')
    const was = useShell.getState().workspace
    inHand(null)
    const st = m()
    if (scan !== undefined) st.setPartShown('scan', scan)
    if (reduced !== undefined) st.setPartShown('reduced', reduced)
    if (piece !== undefined) st.setPartShown('piece', piece)
    if (keys) useMeshTools.setState({ shownBodies: keys })
    if (deviation !== undefined) st.setCopyDeviation(deviation)
    return {
      shown: partsOut().shown,
      deviation: m().copyDeviation,
      workspace: 'mesh',
      ...(was !== 'mesh' ? { back: was, note: `Mesh Tools is on screen in place of ${was}: view.render now pictures these parts, not that workspace's view; workspace.set { workspace: "${was}" } puts it back.` } : {}),
    }
  },
}

const inspect: Command<{ pieceSize?: number; holeSize?: number; deviation?: boolean }> = {
  name: 'inspect',
  title: 'Inspect the mesh',
  description:
    'What the tools would find on the mesh the workspace works on — the edited copy, or the scan while there is none — without changing it: its vertices, triangles and bounds; whether it is closed (open edges, and edges more than two triangles share — mesh.boolean and a hollow need none) and the volume it then encloses, mm³; its connected pieces and the islands among them smaller than pieceSize across (the middle of each), its open rims and the holes among them smaller than holeSize across (the middle of each, for mesh.fill_holes { at }). Sizes default to the panel’s, which start sized to the part. deviation: true also measures the edited copy against the scan in use — the furthest, the RMS, and the share of it an edit made.',
  input: obj({
    pieceSize: sizeIn('A piece smaller than this across is an island, mm.'),
    holeSize: sizeIn('A rim whose longest span is less than this is a hole, mm.'),
    deviation: bool('Measure the edited copy against the scan in use.'),
  }),
  readOnly: true,
  run: async ({ pieceSize, holeSize, deviation }) => {
    requireScan()
    const t = client()
    const islandSize = pieceSize ?? m().pieceSize
    const rimSize = holeSize ?? m().holeSize
    const LIST = 40
    const listed = (centres: Float32Array) => Array.from({ length: Math.min(LIST, centres.length / 3) }, (_, i) => pointOut(centres, i))
    const figures = await t.describe()
    const islands = await t.surveyIslands(islandSize)
    const holes = await t.surveyHoles(rimSize)
    let copyDeviation: Json | null = null
    if (deviation) {
      const copy = editedCopy.current
      if (!copy) throw new CommandError('invalid_state', 'There is no edited copy to measure — the first edit makes one.')
      const stats = summarizeCopyDeviation(await t.editedDeviation(copy.map))
      copyDeviation = { max: stats.maxAbs, rms: stats.rms, added: stats.measured + stats.added > 0 ? stats.added / (stats.measured + stats.added) : 0 }
    }
    return {
      working: m().copyTriangles !== null ? 'edited copy' : 'scan',
      ...figures,
      islands: { size: islandSize, ...islands.survey, centres: listed(islands.centres) },
      holes: { size: rimSize, ...holes.survey, centres: listed(holes.centres) },
      ...(copyDeviation ? { deviation: copyDeviation } : {}),
    }
  },
}

const cutPreview: Command<{ plane: Ref; offset: number; keep?: CutKeep }> = {
  name: 'cut_preview',
  title: 'Preview a cut',
  description:
    'What mesh.cut at this plane would do, without cutting: whether the plane has mesh on both sides of it, how many faces it would close flat, how many holes at the cut it would bridge, and how many stretches of the cut would stay open (where the scan is open across the plane). Changes nothing.',
  input: obj({ plane: planeSchema, offset: offsetSchema, keep: keepSchema }, ['plane', 'offset']),
  readOnly: true,
  run: async ({ plane, offset, keep }) => {
    requireScan()
    const at = planeAt(cutRefOf(plane), offset, keep ?? 'plus')
    const p = await client().cutPreview(at.frame.origin, at.frame.normal)
    return { plane: at.label, cuts: p.cuts, capped: p.capped, bridged: p.bridged, open: p.openStretches }
  },
}

const MARK_COLORS = { delete: DELETE_MARK_COLOR, flip: FLIP_MARK_COLOR, smooth: SMOOTH_MARK_COLOR, offset: OFFSET_MARK_COLOR } as const

const mark: Command<{ region: RegionIn; for?: keyof typeof MARK_COLORS }> = {
  name: 'mark',
  title: 'Mark surface on the part',
  description:
    'Mark a region on the part, as the window, brush and lasso do — in place of whatever is marked — with the tool that is to work on it in hand: delete (orange, the default), flip (amber), smooth or offset (a marked region, blue or violet). Then look at it (view.render) and run that tool with region: "marked", or let the person at the screen put the marking right first. Not a step of the history. Needs the viewport. Returns how many vertices are marked.',
  input: obj({ region: regionSchema('The surface to mark.'), for: enumOf(['delete', 'flip', 'smooth', 'offset'], 'The tool the marking is for.') }, ['region']),
  readOnly: true,
  run: async ({ region, for: tool }) => {
    requireScan()
    if (region === 'marked') invalid('Name the region to mark with a box, a sphere or vertices.')
    const scene = requireScene('Marking the part')
    const vertices = await regionVertices(region)
    const use = tool ?? 'delete'
    // Smooth and Shrink / expand work on a marking only while set to: set
    // here as a way of looking, not as a step of the history.
    if (use === 'smooth') useMeshTools.setState({ smoothScope: 'marked' })
    if (use === 'offset') useMeshTools.setState({ offsetScope: 'marked' })
    inHand(use)
    // The tool before it lets its marking go once the panel is drawn.
    await frames()
    scene.setPaintedVertices(vertices, MARK_COLORS[use])
    useMark.getState().setCount(vertices.length)
    return { marked: vertices.length, for: use }
  },
}

// ---- the edits ---------------------------------------------------------------------------

const removeIslands: Command<{ size?: number }> = {
  name: 'remove_islands',
  title: 'Remove islands',
  description:
    'Delete every connected piece of the mesh smaller across than size — the specks floating off a scan, a patch of the turntable — keeping every larger piece (a ball bar’s two balls and its rod all stay). size defaults to the panel’s, which starts at a hundredth of the part’s size; mesh.inspect counts the islands at a size first. Edits the copy (made by the first edit; every other workspace measures the scan until mesh.use_edited). One undo step. Returns the edit, the worker’s report and the mesh after it.',
  input: obj({ size: sizeIn('A piece smaller than this across — its bounding box — is an island, mm.') }),
  history: false,
  run: async ({ size }) =>
    editAnswer(
      await step('remove islands', 'Removing the islands', async () => {
        inHand('islands')
        if (size !== undefined) m().setPieceSize(size)
        return session().removeIslands({ inStep: true })
      }, true),
    ),
}

const deleteMarked: Command<{ region: RegionIn }> = {
  name: 'delete_marked',
  title: 'Delete surface',
  description:
    'Delete the surface a region holds — what is not the part: the clamp that held it, the fixture it sat in, a patch of the table. A triangle goes when all three of its corners are in the region; the hole it leaves stays open (mesh.fill_holes closes it). To take off everything past a plane, mesh.cut is the better tool. Edits the copy. One undo step. Returns the edit and the mesh after it.',
  input: obj({ region: regionSchema('The surface to delete.') }, ['region']),
  history: false,
  run: async ({ region }) => {
    requireScan()
    const vertices = await regionVertices(region)
    return editAnswer(
      await step('delete surface', 'Deleting the surface', async () => {
        inHand('delete')
        return session().deleteMarked(vertices, { inStep: true })
      }, true),
    )
  },
}

const flipNormals: Command<{ region?: RegionIn }> = {
  name: 'flip_normals',
  title: 'Flip normals',
  description:
    'Turn triangles over so they face the other way — every one, or with region those with all three corners in it. For a part exported inside-out (a closed one is turned outward when opened; an open scan or a sheet is left as wound), or patches of a scan that face in. A closed mesh flipped whole encloses a negative volume (mesh.inspect). Nothing moves. Edits the copy. One undo step. Returns the edit and the mesh after it.',
  input: obj({ region: regionSchema('Flip only this surface; absent, the whole mesh.') }),
  history: false,
  run: async ({ region }) => {
    requireScan()
    const vertices = region !== undefined ? await regionVertices(region) : null
    return editAnswer(
      await step(vertices ? 'flip the normals of a region' : 'flip the normals', 'Flipping', async () => {
        inHand('flip')
        return session().flipScan(vertices, { inStep: true })
      }, true),
    )
  },
}

const cut: Command<{ plane: Ref; offset: number; keep: CutKeep; cap?: boolean }> = {
  name: 'cut',
  title: 'Cut the mesh',
  description:
    'Cut the mesh with a plane and take one side off — the base or table the part stood on, a flat bottom for a print, one half of a part. cap closes the part flat wherever the plane goes all the way round it (on to start), bridging a hole in the wall that sits right at the cut, so a closed part stays closed; where the scan is open across the plane the cut stays open. mesh.cut_preview says what it would do. Edits the copy. One undo step. Returns the edit and the mesh after it.',
  input: obj(
    { plane: planeSchema, offset: offsetSchema, keep: keepSchema, cap: bool('Close the part flat where the plane crosses it.') },
    ['plane', 'offset', 'keep'],
  ),
  history: false,
  run: async ({ plane, offset, keep, cap }) => {
    requireScan()
    const ref = cutRefOf(plane)
    const at = planeAt(ref, offset, keep)
    return editAnswer(
      await step(`cut at ${at.label}`, 'The cut', async () => {
        inHand('cut')
        m().setCutRef(ref)
        m().setCutOffset(offset)
        m().setCutKeep(keep)
        if (cap !== undefined) m().setCutCap(cap)
        return session().cutScan({ inStep: true })
      }, true),
    )
  },
}

const fillHoles: Command<{ size?: number; patch?: FillMode; at?: Vec3 }> = {
  name: 'fill_holes',
  title: 'Fill holes',
  description:
    'Close the holes in the mesh smaller across than size — where the scanner could not see — or, with at, only the one of them whose middle is nearest that point (mesh.inspect lists them). A patch is triangulated to bend least, refined to the density around it and faired: curved continues the surface’s bending across the hole, flat lays the tightest patch across it. The scan’s own vertices do not move. size defaults to the panel’s, a twentieth of the part’s size to start — well short of the opening a part scanned standing on its base leaves. Edits the copy. One undo step. Returns the edit and the mesh after it — closed tells whether it is now closed.',
  input: obj({
    size: sizeIn('A rim whose longest span is less than this is a hole, mm.'),
    patch: enumOf(['curved', 'flat'] as FillMode[], 'curved (to start) or flat.'),
    at: vec3('Fill only the hole whose middle is nearest this point, mm.'),
  }),
  history: false,
  run: async ({ size, patch, at }) =>
    editAnswer(
      await step(at ? 'fill a hole' : 'fill holes', 'Filling', async () => {
        inHand('holes')
        if (size !== undefined) m().setHoleSize(size)
        if (patch !== undefined) m().setFillMode(patch)
        return session().fillScanHoles(at, { inStep: true })
      }, true),
    ),
}

const smooth: Command<{ size?: number; limit?: number; keepEdges?: boolean; region?: RegionIn }> = {
  name: 'smooth',
  title: 'Smooth the mesh',
  description:
    'Smooth a scan’s scatter out: each point moved along its normal onto a surface fitted to the scan around it over a patch size across — bumps smaller than size go, the shape larger than it (faces, bores, fillets) stays. No point moves further than limit. keepEdges fits each side of an edge sharper than 30° on its own and leaves the edge as scanned (on to start). With region only that surface moves, fading out to its edge. Sizes default to the panel’s, sized to the part. Edits the copy. One undo step. Returns the edit (how far it moved the surface) and the mesh after it.',
  input: obj({
    size: sizeIn('Bumps smaller than this across are smoothed out, mm.'),
    limit: sizeIn('No point moves further than this, mm.'),
    keepEdges: bool('Keep sharp edges as scanned.'),
    region: regionSchema('Smooth only this surface; absent, the whole mesh.'),
  }),
  history: false,
  run: async ({ size, limit, keepEdges, region }) => {
    requireScan()
    const vertices = region !== undefined ? await regionVertices(region) : null
    return editAnswer(
      await step(vertices ? 'smooth a region' : 'smooth', 'Smoothing', async () => {
        m().setSmoothScope(vertices ? 'marked' : 'all')
        inHand('smooth')
        if (size !== undefined) m().setSmoothSize(size)
        if (limit !== undefined) m().setSmoothLimit(limit)
        if (keepEdges !== undefined) m().setSmoothEdges(keepEdges)
        return session().smoothScan(vertices, { inStep: true })
      }, true),
    )
  },
}

const offset: Command<{ direction: OffsetDirection; distance: number; region?: RegionIn }> = {
  name: 'offset',
  title: 'Shrink or expand',
  description:
    'Move the surface along its normal by distance: expand (the part grows) or shrink. Not a scale — a 20 mm ball expanded 0.5 mm is 21 mm across and a bore comes out a millimetre narrower; for the thickness a scanning spray laid on, a clearance, a print that came out fat. Faces end the distance from where they were and edges stay sharp. With region only that surface moves, as a step: its rim slides along a face that runs along the move, or a wall joins it to the surface. Edits the copy. One undo step. Returns the edit and the mesh after it.',
  input: obj(
    {
      direction: enumOf(['expand', 'shrink'] as OffsetDirection[], 'expand or shrink.'),
      distance: sizeIn('How far, mm.'),
      region: regionSchema('Move only this surface; absent, the whole mesh.'),
    },
    ['direction', 'distance'],
  ),
  history: false,
  run: async ({ direction, distance, region }) => {
    requireScan()
    const vertices = region !== undefined ? await regionVertices(region) : null
    return editAnswer(
      await step(`${direction}${vertices ? ' a region' : ''} by ${distance} mm`, direction === 'expand' ? 'Expanding' : 'Shrinking', async () => {
        m().setOffsetScope(vertices ? 'marked' : 'all')
        inHand('offset')
        m().setOffsetDirection(direction)
        m().setOffsetDistance(distance)
        return session().offsetScan(vertices, { inStep: true })
      }, true),
    )
  },
}

const boolean: Command<{ op: BooleanOp; solids: string[] }> = {
  name: 'boolean',
  title: 'Boolean with solids',
  description:
    'Make the mesh and solids one: subtract them from it, add them to it, or intersect (keep what both hold). The solids are those on offer (mesh.parts lists them by key and name): the cylinders, cones and spheres measured in 3D Measure as drawn there — at their assumed Ø and as far as they were extended — and the bodies modelled in the Reverse engineer workspace. Several go as one, their union. The mesh must be closed (mesh.inspect; mesh.fill_holes first). For a bore the scanner could not see to the bottom of: fit a cylinder to its wall in 3D Measure, extend it past the bottom and out through the surface, and subtract it. Edits the copy. One undo step. Returns the edit (the volume change) and the mesh after it.',
  input: obj(
    {
      op: enumOf(['subtract', 'add', 'intersect'] as BooleanOp[], 'subtract, add or intersect.'),
      solids: arr(str(undefined, { minLength: 1 }), 'The solids, by key or name.', { minItems: 1 }),
    },
    ['op', 'solids'],
  ),
  history: false,
  run: async ({ op, solids }) => {
    requireScan()
    const keys = [...new Set(solids.map((s) => solidNamed(s).key))]
    const closed = await client().closedness()
    if (closed.open > 0 || closed.bad > 0) {
      throw new CommandError(
        'invalid_state',
        `The mesh is not closed — ${closed.open} open edges, ${closed.bad} shared by more than two triangles. A boolean needs it closed: close it with mesh.fill_holes first.`,
      )
    }
    const names = keys.map((k) => booleanSolids().find((s) => s.key === k)!.name).join(', ')
    return editAnswer(
      await step(`${op} ${names}`, 'The boolean', async () => {
        inHand('boolean')
        m().setBoolOp(op)
        m().setBoolSolids(keys)
        return session().booleanScan({ inStep: true })
      }, true),
    )
  },
}

const shell: Command<{ thickness?: number; side?: ThickenSide; mode?: 'hollow' | 'thicken' }> = {
  name: 'shell',
  title: 'Hollow or thicken',
  description:
    'A closed part is hollowed: its outside stays as scanned and an inner wall thickness in from it seals a cavity (where the part is thinner than twice the wall it stays solid). An open surface — one side of a part, a sheet — is thickened into a solid: a second skin thickness from it, side in (the scanned surface stays the outside), out or both, and a wall round every rim. A part closed but for holes smaller than the Fill holes size is refused: fill them (mesh.fill_holes) to hollow it, or pass mode: "thicken" to thicken it as it is. thickness defaults to the panel’s, a 125th of the part’s diagonal to start. Edits the copy. One undo step. Returns the edit and the mesh after it.',
  input: obj({
    thickness: sizeIn('The wall a hollow leaves, or the thickness a surface is given, mm.'),
    side: enumOf(['in', 'out', 'both'] as ThickenSide[], 'For a surface: which way the wall grows from it — in to start.'),
    mode: enumOf(['hollow', 'thicken'], 'What to do; absent, what the mesh calls for.'),
  }),
  history: false,
  run: async ({ thickness, side, mode }) => {
    requireScan()
    const t = client()
    const closed = await t.closedness()
    let calls: 'hollow' | 'thicken' | 'holes' = 'hollow'
    let holes = 0
    if (closed.open > 0) {
      const { survey } = await t.surveyHoles(m().holeSize)
      holes = survey.holes
      calls = shellModeOf({ open: closed.open, rims: survey.rims, holes: survey.holes })
    }
    if (mode === 'hollow' && calls !== 'hollow') {
      throw new CommandError('invalid_state', `The mesh is open — ${closed.open} open edges — and only a closed part can be hollowed${calls === 'holes' ? `: fill its ${holes} hole${holes === 1 ? '' : 's'} with mesh.fill_holes first` : ''}.`)
    }
    if (mode === 'thicken' && calls === 'hollow') throw new CommandError('invalid_state', 'The mesh is closed — hollow it; only an open surface is thickened.')
    if (!mode && calls === 'holes') {
      throw new CommandError(
        'invalid_state',
        `The part is closed but for ${holes} hole${holes === 1 ? '' : 's'} smaller than ${m().holeSize} mm — fill ${holes === 1 ? 'it' : 'them'} with mesh.fill_holes to hollow it, or pass mode: "thicken" to thicken it as it is, with a wall round every hole.`,
      )
    }
    const doing = mode ?? (calls === 'hollow' ? 'hollow' : 'thicken')
    return editAnswer(
      await step(doing, doing === 'hollow' ? 'Hollowing' : 'Thickening', async () => {
        inHand('shell')
        if (thickness !== undefined) m().setShellThickness(thickness)
        if (side !== undefined) m().setShellSide(side)
        return session().shellScan(doing, { inStep: true })
      }, true),
    )
  },
}

// ---- beside the scan ------------------------------------------------------------------------

const reduce: Command<{ tolerance?: number; maxTriangles?: number }> = {
  name: 'reduce',
  title: 'Reduce the mesh',
  description:
    'Reduce the mesh the workspace works on to a light one for CAD, held within tolerance of it — 99.9 % of each side within it, measured both ways, not trusted — and never more than maxTriangles (when the tolerance needs more, it is reduced to the limit and says how far it then strays). Made where the part stands: align it first if it should land in CAD on its datums, and take islands off first. Defaults are the panel’s: a tolerance sized to the part (0.05 mm a hand’s width across), 50,000 triangles. The reduced mesh is made beside the scan, not an edit of it; mesh.export { part: "reduced" } writes it. Returns its figures.',
  input: obj({
    tolerance: sizeIn('How far the reduced mesh may stray from the scan, either side, mm.'),
    maxTriangles: int('Never more triangles than this — what the CAD system takes.', { minimum: 4 }),
  }),
  history: false,
  run: async ({ tolerance, maxTriangles }) => {
    await step('reduce the mesh', 'The reduction', async () => {
      inHand('reduce')
      m().setView('reduced')
      if (tolerance !== undefined) m().setTolerance(tolerance)
      if (maxTriangles !== undefined) m().setMaxTriangles(maxTriangles)
      const report = await session().reduce()
      if (!report) useStore.setState({ errorText: m().message ?? useStore.getState().errorText })
      return report
    }, false)
    return { reduced: reductionOut(), status: useStore.getState().statusText }
  },
}

const trim: Command<{ body: string; offset?: number; depth?: number; flip?: boolean; region?: RegionIn }> = {
  name: 'trim',
  title: 'Trim a body to the scan',
  description:
    'Mend a broken part: cut a body — the missing piece modelled in the Reverse engineer workspace to the part’s nominal shape and a few millimetres too long at the break — with the scanned fracture, to print and glue in. The break is where the scan lies deeper in the body than depth (0.3 mm to start; the part’s own skins dip in only by the scatter and the difference in size); region names it instead (or "marked", as the person put it right on screen). offset sets the mating face back from the break (0 cuts on it, a tenth or two leaves room for glue); flip keeps the other side. The piece is made beside the scan, not an edit of it; mesh.export { part: "piece" } writes it. Returns the piece: its volume, mating face, and how far that face is from the part.',
  input: obj(
    {
      body: str('The body, by key or name (mesh.parts lists them).', { minLength: 1 }),
      offset: num('How far the mating face sits back from the break, mm.', { minimum: 0 }),
      depth: sizeIn('How much deeper in the body than its surface the scan must lie to be break, mm.'),
      flip: bool('Keep what is on the other side of the break.'),
      region: regionSchema('The break; absent, the break as found.'),
    },
    ['body'],
  ),
  history: false,
  run: async ({ body, offset: off, depth, flip, region }) => {
    requireScan()
    const solid = solidNamed(body)
    const marked = region !== undefined ? await regionVertices(region) : null
    const made = await step(`trim ${solid.name} to the break`, 'The trim', async () => {
      inHand('trim')
      m().setTrimSolid(solid.key)
      if (off !== undefined) m().setTrimOffset(off)
      if (depth !== undefined) m().setTrimDepth(depth)
      if (flip !== undefined) m().setTrimFlip(flip)
      const landed = await session().trimScan(marked)
      if (!landed) useStore.setState({ errorText: m().trimMessage ?? useStore.getState().errorText })
      return landed
    }, false)
    return { piece: pieceOut(), status: made.status }
  },
}

// ---- the copy -----------------------------------------------------------------------------

const requireCopy = () => {
  if (!editedCopy.current) throw new CommandError('invalid_state', 'There is no edited copy — the first edit makes one.')
}

const useEdited: Command = {
  name: 'use_edited',
  title: 'Use the edited mesh for analysis',
  description:
    'Take the edited copy into use: it becomes the scan every workspace measures, loaded in place of it under everything measured on it — the elements fitted again on it, the sections cut again, the maps and a reduction measured again. The edits move to the scan’s list; the next edit makes a new copy. One undo step, which goes back to the scan before. Returns the scan in use.',
  input: noInput,
  history: false,
  run: async () => {
    requireScan()
    requireCopy()
    await step('use the edited mesh for analysis', 'Taking the copy into use', async () => ((await session().adoptEditedCopy({ inStep: true })) ? true : null), true)
    const s = useStore.getState()
    return { scan: { name: s.fileName, triangles: s.triangleCount, edits: m().edits.map(editOut) }, status: s.statusText }
  },
}

const discardEdited: Command = {
  name: 'discard_edited',
  title: 'Discard the edits',
  description:
    'Throw the edited copy and the edits waiting on it away: the tools work on the scan in use again. One undo step, which brings them back. Returns the mesh the workspace works on.',
  input: noInput,
  history: false,
  run: async () => {
    requireScan()
    requireCopy()
    await step('discard the edits', 'Discarding the edits', async () => ((await session().discardEditedCopy({ inStep: true })) ? true : null), true)
    return { mesh: await meshOut(), status: useStore.getState().statusText }
  },
}

const exportPart: Command<{ part: 'edited' | 'reduced' | 'piece'; format?: MeshFormat }> = {
  name: 'export',
  title: 'Export a part as a mesh',
  description:
    'A part of the workspace as a binary STL in millimetres — or, format 3mf, a 3MF, which says its units — in the pose the part is shown in — an alignment, and a best fit onto the reference, included: edited (the edited copy as it stands), reduced (the reduced mesh on screen) or piece (the piece Trim to scan made). The reduced mesh and the piece need the viewport. Returns the file’s bytes and the name the panel would save it under.',
  input: obj({ part: enumOf(['edited', 'reduced', 'piece'], 'Which part.'), format: enumOf([...MESH_FORMATS], 'stl (the default) or 3mf.') }, ['part']),
  readOnly: true,
  returnsFile: true,
  run: async ({ part, format = 'stl' }) => {
    requireScan()
    let built: BuiltFile | null
    try {
      built =
        part === 'edited'
          ? buildEditedMesh(format)
          : part === 'reduced'
            ? buildReducedMesh(requireScene('The reduced mesh’s export'), format)
            : buildTrimmedMesh(requireScene('The piece’s export'), format)
    } catch (e) {
      if (e instanceof CommandError) throw e
      throw new CommandError('failed', errorMessage(e))
    }
    if (!built) {
      throw new CommandError(
        'invalid_state',
        part === 'edited' ? 'There is no edited copy — the first edit makes one.' : part === 'reduced' ? 'There is no reduced mesh — mesh.reduce makes one.' : 'There is no piece — mesh.trim makes one.',
      )
    }
    return { file: { name: built.name, mimeType: built.mimeType, bytes: built.bytes }, status: built.status }
  },
}

/** The workspace's commands, in the order a cleanup goes: what is there,
 *  islands and marked surface off, the normals the right way, the cut, the
 *  holes, smoothing, a shrink
 *  or an expansion, a boolean, the shell, and the reduction last. */
export const meshCommands = [
  parts,
  show,
  inspect,
  cutPreview,
  mark,
  removeIslands,
  deleteMarked,
  flipNormals,
  cut,
  fillHoles,
  smooth,
  offset,
  boolean,
  shell,
  reduce,
  trim,
  useEdited,
  discardEdited,
  exportPart,
] as Command<never>[]

/** What the workspace is busy with that a command must not run over. */
export function meshBusy(): string | null {
  const s = useMeshTools.getState()
  if (s.editing) return 'the mesh is being edited'
  if (s.status === 'running') return 'the mesh is being reduced'
  if (s.trimStatus === 'running') return 'a body is being trimmed to the scan'
  return null
}

