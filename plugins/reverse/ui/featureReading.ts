// SPDX-License-Identifier: AGPL-3.0-only
// What a feature reads, in the feature list's row and in the playback's
// caption: the picture of its kind, the number it turns on, and what it did
// to its body, in a word and in a sentence. Lengths read in the display
// units; with none given, millimetres.

import { unitWord, type DisplayUnits } from '../../../src/core/units'
import { type ExtrudeExtent, type Feature, toolsOf } from '../core/features'
import { describePlaneRef } from '../core/resolve'
import { threadName } from '../core/thread'
import { describeEdgeIn, describeFaceIn } from '../core/topo'
import type { KeyIconName } from './reIcons'
import { lenBare, lenShort } from './reLength'

/** A file's size as a person reads it. */
export const fileSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

/** The one number a feature row reads beside its body operation: how far
 *  an extrude reaches, how far a revolve turns. */
export function keyParameter(f: { kind: 'extrude'; extent: ExtrudeExtent } | { kind: 'revolve'; angleDeg: number }, units: DisplayUnits = 'mm'): string {
  if (f.kind === 'revolve') return `${Math.round(f.angleDeg * 100) / 100}°`
  const e = f.extent
  switch (e.kind) {
    case 'distance':
      return lenShort(Math.abs(e.to - e.from), units)
    case 'symmetric':
      return lenShort(e.total, units)
    case 'toPlane':
      return 'to a plane'
    case 'toFace':
      return 'to a face'
    case 'toBody':
      return 'to a body'
    case 'toNext':
      return 'to next'
    case 'toLast':
      return 'to last'
    case 'betweenPlanes':
      return 'between planes'
  }
}

/** The icon each kind of feature carries in its row. */
export const FEATURE_ICONS: Record<Feature['kind'], KeyIconName> = {
  sketch: 'sketch',
  extrude: 'extrude',
  revolve: 'revolve',
  shell: 'shell',
  fillet: 'fillet',
  chamfer: 'chamfer',
  hole: 'hole',
  // A thread is a screw of a profile about an axis — Revolve's picture, as
  // a coil's is; the key that starts one has a picture of its own.
  thread: 'revolve',
  extract: 'extract',
  cutPlane: 'cutPlane',
  mirror: 'mirror',
  boolean: 'combine',
  sheet: 'sheet',
  split: 'split',
  loft: 'loft',
  // A section carried along a path: a loft's picture is the nearest.
  sweep: 'loft',
  // A sheet made a wall: the wall of a shell is the nearest picture.
  thicken: 'shell',
  pattern: 'pattern',
  draft: 'draft',
  moveFace: 'moveFace',
  deleteFace: 'deleteFace',
  // A body grown all round: the wall of a shell is the nearest picture.
  offsetBody: 'shell',
  import: 'importStep',
  moveBody: 'moveBody',
  surface: 'surface',
  // Patches fitted to the scan: a fitted surface's picture.
  network: 'surface',
  trim: 'trim',
}

/** What a row reads for a feature on a body, and the tooltip behind it. */
export function bodyFeatureReading(f: Exclude<Feature, { kind: 'sketch' | 'extrude' | 'revolve' }>, names: (id: number) => string, ctx: { sections: readonly { id: number; name: string }[]; elements: readonly { id: number; name: string }[] }, units: DisplayUnits = 'mm'): { text: string; title: string } {
  /** A length with its unit, to the hundredth of a millimetre. */
  const len = (v: number) => lenShort(v, units)
  /** The same without the unit, where the unit follows a second figure. */
  const bare = (v: number) => lenBare(v, units, 2)
  const faceText = describeFaceIn(units)
  const edgeText = describeEdgeIn(units)
  switch (f.kind) {
    case 'shell':
      return { text: `${len(f.thickness)} wall`, title: `${names(f.body)} hollowed to a ${len(f.thickness)} wall, ${f.faces.length} face${f.faces.length === 1 ? '' : 's'} opened: ${f.faces.map(faceText).join('; ')}` }
    case 'fillet': {
      const varying = f.variable ?? []
      const radii = [...(f.edges.length > 0 ? [`R ${len(f.radius)}`] : []), ...varying.map((v) => `R ${bare(v.radius[0])} → ${len(v.radius[1])}`)]
      const plain = f.edges.length > 0 ? `${f.edges.length} edge${f.edges.length === 1 ? '' : 's'} of ${names(f.body)} rounded${f.chain ? ', tangent chains along' : ''}: ${f.edges.map(edgeText).join('; ')}` : ''
      const vary = varying.length > 0 ? `${varying.length} edge${varying.length === 1 ? '' : 's'}${f.edges.length > 0 ? '' : ` of ${names(f.body)}`} rounded at a varying radius, start → end: ${varying.map((v) => `${edgeText(v.edge)} ${len(v.radius[0])} → ${len(v.radius[1])}`).join('; ')}` : ''
      return { text: radii.length > 2 ? `${radii[0]} · ${radii.length - 1} more` : radii.join(' · '), title: [plain, vary].filter(Boolean).join('; and ') }
    }
    case 'chamfer': {
      const size = f.mode === 'twoDistances' ? `${bare(f.distance)} × ${len(f.distance2 ?? f.distance)}` : f.mode === 'distanceAngle' ? `${len(f.distance)} × ${Math.round((f.angleDeg ?? 45) * 100) / 100}°` : len(f.distance)
      const how = f.mode === 'twoDistances' ? `, ${len(f.distance)} on the reference face and ${len(f.distance2 ?? f.distance)} on the other${f.flip ? ' (flipped)' : ''}` : f.mode === 'distanceAngle' ? `, ${len(f.distance)} on the reference face at ${f.angleDeg ?? 45}° to it${f.flip ? ' (flipped)' : ''}` : ''
      return { text: size, title: `${f.edges.length} edge${f.edges.length === 1 ? '' : 's'} of ${names(f.body)} chamfered${how}${f.chain ? ', tangent chains along' : ''}: ${f.edges.map(edgeText).join('; ')}` }
    }
    case 'hole': {
      const axis = f.axis
      const along = axis.kind === 'element' ? `along ${ctx.elements.find((e) => e.id === axis.id)?.name ?? 'a deleted element'}` : axis.kind === 'point' ? `into ${faceText(axis.face)} at its centre` : `along ${faceText(axis.face)}`
      return { text: `${f.insert ? `${f.insert} insert · ` : ''}Ø ${len(2 * f.radius)}${f.depth === null ? ' through' : ` × ${len(f.depth)}`}`, title: `A hole ${f.insert ? `for an ${f.insert} heat-set insert ` : ''}in ${names(f.body)}, ${along}` }
    }
    case 'thread': {
      const name = threadName(f.standard, f.diameter, f.pitch)
      const where = f.length === null ? 'the whole face' : `${len(f.length)} from ${len(f.start)} in`
      return { text: `${name}${f.leftHanded ? ' LH' : ''}${f.offset > 0 ? ` · −${len(f.offset)}` : ''}${f.chamfer ? ' · 45°' : ''}`, title: `A ${f.leftHanded ? 'left' : 'right'}-hand ${name} thread on ${faceText(f.face)} of ${names(f.body)}, ${where}${f.offset > 0 ? `, every face of it ${len(f.offset)} into the material for clearance` : ''}${f.chamfer ? ', chamfered at 45° where it comes out of the body' : ''}` }
    }
    case 'extract': {
      const op = f.op === 'new' ? 'New body' : f.op === 'join' ? 'Join' : 'Cut'
      if (f.section !== undefined) return { text: `${op} · ${ctx.sections.find((x) => x.id === f.section)?.name ?? 'deleted section'}`, title: 'The shadow section’s outline stood up through the part’s thickness' }
      return { text: `${op} · ${ctx.elements.find((e) => e.id === f.element)?.name ?? 'deleted element'}`, title: `The element as a solid at its fitted extents${f.thickness > 0 ? `, a plane as a ${len(f.thickness)} slab` : ''}` }
    }
    case 'cutPlane':
      return { text: `at ${describePlaneRef(f.plane, ctx, units)}`, title: `${names(f.body)} cut at the plane, the side ${f.keep > 0 ? 'along' : 'against'} its normal kept` }
    case 'mirror':
      return { text: `about ${f.plane.kind === 'face' ? faceText(f.plane.face) : describePlaneRef(f.plane, ctx, units)}${f.join ? ' · joined' : ''}`, title: `${names(f.body)} mirrored${f.join ? ' and joined with the source' : ' into a body of its own'}` }
    case 'boolean': {
      const tools = toolsOf(f).map(names).join(', ')
      const one = toolsOf(f).length === 1
      return { text: `${f.op === 'join' ? 'Join' : f.op === 'cut' ? 'Cut' : 'Intersect'} ${tools}${f.keep ? ' · kept' : ''}`, title: `${names(f.body)} ${f.op === 'join' ? 'joined with' : f.op === 'cut' ? 'cut by' : 'intersected with'} ${tools}${!one && f.op !== 'join' ? ' in turn' : ''}, ${f.keep ? `which stay${one ? 's' : ''} ${one ? 'a body' : 'bodies'} of ${one ? 'its' : 'their'} own` : `which go${one ? 'es' : ''} into it`}` }
    }
    case 'sheet':
      return { text: `Surface · ${len(Math.abs(f.to - f.from))}`, title: `${names(f.sketchId)}'s pieces extruded as a surface from ${len(f.from)} to ${len(f.to)} along its normal — a cutter, not exported on its own` }
    case 'split':
      return { text: `by ${f.tools.map(names).join(', ')} · ${f.keep === 'scan' ? 'on the scan' : f.keep}`, title: `${names(f.body)} split by ${f.tools.map(names).join(', ')}, the fragments ${f.keep === 'scan' ? `lying on the scan within ${len(f.tolerance)} over ${Math.round(f.overlap * 100)} % of their faces` : f.keep === 'between' ? 'lying between the sheets' : `the ${f.keep}`} kept` }
    case 'loft':
      return { text: `${f.op === 'new' ? 'New body' : f.op === 'join' ? 'Join' : 'Cut'} · ${f.sketches.length} sketches${f.ruled ? '' : ', smooth'}`, title: `A ${f.ruled ? 'ruled' : 'smooth'} loft through ${f.sketches.map(names).join(', ')}` }
    case 'sweep':
      if (f.route) {
        const bends = f.route.points.length - 2
        return { text: `${f.op === 'new' ? 'New body' : f.op === 'join' ? 'Join' : 'Cut'} · 3D route, ${bends} bend${bends === 1 ? '' : 's'}`, title: `${names(f.profile)}'s largest region swept along a route of ${f.route.points.length} points in 3D, bends of radius ${len(f.route.bendRadius)}${f.route.radii?.some((r) => r !== null) ? ' or their own' : ''}` }
      }
      return { text: `${f.op === 'new' ? 'New body' : f.op === 'join' ? 'Join' : 'Cut'} · along ${names(f.path!)}`, title: `${names(f.profile)}'s largest region swept along ${names(f.path!)}` }
    case 'thicken':
      return { text: `${f.op === 'new' ? 'New body' : f.op === 'join' ? 'Join' : 'Cut'} · ${len(f.thickness)} ${f.side}`, title: `${names(f.sheet)} made a solid ${len(f.thickness)} thick, ${f.side === 'out' ? 'along its normal' : f.side === 'in' ? 'against its normal' : 'half each way'}${f.op === 'new' ? ', a body of its own' : f.op === 'join' ? ', joined to what it meets' : ', cut from what it meets'}` }
    case 'draft':
      return { text: `${Math.round(f.angleDeg * 100) / 100}° · ${f.faces.length} face${f.faces.length === 1 ? '' : 's'}`, title: `${f.faces.length} face${f.faces.length === 1 ? '' : 's'} of ${names(f.body)} leaned ${f.angleDeg}° about ${f.neutral.kind === 'face' ? faceText(f.neutral.face) : describePlaneRef(f.neutral, ctx, units)}: ${f.faces.map(faceText).join('; ')}` }
    case 'moveFace': {
      const sign = `${f.offset >= 0 ? '+' : '−'}${len(Math.abs(f.offset))}`
      if (f.faces.length !== 1) return { text: `${sign} · ${f.faces.length} faces`, title: `${f.faces.length} faces of ${names(f.body)} offset by ${len(f.offset)} — the flat ones along their outward normals, the round ones in radius: ${f.faces.map(faceText).join('; ')}` }
      const face = f.faces[0]
      return { text: sign, title: `${faceText(face)} of ${names(f.body)} ${face.kind === 'cylinder' ? `resized by ${len(f.offset)} in radius` : `moved ${len(Math.abs(f.offset))} ${f.offset >= 0 ? 'outward' : 'inward'} along its normal`}` }
    }
    case 'deleteFace':
      return { text: `${f.faces.length} face${f.faces.length === 1 ? '' : 's'}`, title: `${f.faces.length} face${f.faces.length === 1 ? '' : 's'} taken off ${names(f.body)}, the faces round them run on over the gap: ${f.faces.map(faceText).join('; ')}` }
    case 'pattern':
      return f.mode === 'linear' && f.axis2 && (f.count2 ?? 1) > 1
        ? { text: `${f.count} × ${f.count2} · ${len(f.step)} × ${len(f.step2 ?? 0)}`, title: `${names(f.body)} in a grid: ${f.count} along its first direction every ${len(f.step)}, ${f.count2} rows every ${len(f.step2 ?? 0)}` }
        : { text: `${f.count} × ${f.mode === 'circular' ? `over ${Math.round(f.step * 100) / 100}°` : `every ${len(f.step)}`}`, title: `${names(f.body)} ${f.mode === 'circular' ? 'turned about' : 'stepped along'} its axis, ${f.count} in all` }
    case 'offsetBody':
      return { text: `${f.distance >= 0 ? '+' : '−'}${len(Math.abs(f.distance))}${f.keep ? ' · new body' : ''}`, title: `${names(f.body)} ${f.distance >= 0 ? 'grown' : 'shrunk'} ${len(Math.abs(f.distance))} all round${f.keep ? ', the body kept as it was and the offset a body of its own' : ''}` }
    case 'trim':
      return { text: `${f.tools.length} surface${f.tools.length === 1 ? '' : 's'} · within ${len(f.tolerance)}`, title: `A box round the scan cut by ${f.tools.map((t) => (t.kind === 'body' ? names(t.id) : (ctx.elements.find((e) => e.id === t.id)?.name ?? 'a deleted element'))).join(', ')}; the faces lying on the scan within ${len(f.tolerance)} over ${Math.round(f.overlap * 100)} % of their samples kept and sewn` }
    case 'import':
      return { text: f.file.name, title: `${f.file.name} imported — ${fileSize(f.file.size)}: a body for every solid in it, named as the file names its parts` }
    case 'moveBody':
      return moveReading(f, names, units)
    case 'network': {
      const curves = f.curves.length
      const cells = f.cells.length
      return { text: `${cells} patch${cells === 1 ? '' : 'es'} · ${curves} curve${curves === 1 ? '' : 's'}`, title: `A patch network: ${curves} curve${curves === 1 ? '' : 's'} drawn on the scan, ${f.curves.filter((c) => c.crease).length} of them creases, and ${cells} region${cells === 1 ? '' : 's'} they close filled with B-spline patches fitted to the scan together — sharing the curves between them and meeting tangent across every one not marked a crease. A sheet, or a solid where the network closes` }
    }
    case 'surface':
      return { text: `Surface · ${f.region.length.toLocaleString('en-US')} points`, title: `A freeform surface fitted through ${f.region.length.toLocaleString('en-US')} points of the scan — a ${f.fit.net ? `${f.fit.net.u} × ${f.fit.net.v}` : 'self-sized'} net of degree ${f.fit.degree}, reaching ${f.fit.expandPct} % past the region. A surface body: trimmed with the others into a solid, not exported on its own` }
  }
}

/** What a Move's row reads: Copy where it copies, how far it carries the
 *  bodies, and the turn — the angle where it turns about one axis. */
function moveReading(f: Extract<Feature, { kind: 'moveBody' }>, names: (id: number) => string, units: DisplayUnits): { text: string; title: string } {
  const round = (v: number) => Math.round(v * 100) / 100
  const bare = (v: number) => lenBare(v, units, 2)
  const length = Math.hypot(...f.translate)
  const turns = f.rotate.filter((v) => v !== 0)
  const words = [length > 0 ? lenShort(length, units) : null, turns.length === 1 ? `${round(turns[0])}°` : turns.length > 1 ? 'turned' : null].filter((w): w is string => w !== null)
  const text = `${f.copy ? 'Copy · ' : ''}${words.join(' · ') || 'in place'}`
  const who = f.bodies.length === 1 ? names(f.bodies[0]) : `${f.bodies.length} bodies`
  const done = [length > 0 ? `carried ${f.translate.map(bare).join(', ')} ${unitWord(units)} along X, Y, Z` : null, turns.length > 0 ? `turned ${f.rotate.map(round).join(', ')}° about X, Y and Z through ${f.pivot.map(bare).join(', ')}` : null].filter((w): w is string => w !== null)
  return { text, title: `${who}${f.copy ? ' copied, the copy' : ''} ${done.join(', then ') || 'left where it stood'}` }
}
