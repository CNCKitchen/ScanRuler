// SPDX-License-Identifier: AGPL-3.0-only
// A spur gear modelled from its scan through the commands alone — what an
// agent does over MCP, and what the tests do headless: the part stood on
// its axis (align.auto), the teeth read off a section through them
// (reverse.section.fit periodic), one tooth taken off the section's outline
// and patterned round the axis in one sketch with the root circle, the
// sketch extruded across the teeth, a hub on top where there is one, the
// bore cut through, and the bodies compared with the scan.
//
// The model is parametric where a gear is: the tooth count is the sketch
// pattern's count, the root circle's radius and the extrusions' heights are
// numbers in the features, each editable on its own.
//
// `call(name, input)` runs one command and answers its JSON — a page's
// runCommand, the headless kit's run, or an MCP tool (name with its dots as
// underscores).

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** At most `max` of `pts`, every k-th, the last kept — and no corner on
 *  the one before it, nor a closed outline's first repeated at its end:
 *  a sketch's polyline makes a line between each two. */
const decimate = (pts, max) => {
  const step = Math.max(1, Math.ceil(pts.length / max))
  const kept = pts.filter((_, k) => k % step === 0 || k === pts.length - 1)
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3
  const out = kept.filter((p, k) => k === 0 || !near(p, kept[k - 1]))
  while (out.length > 3 && near(out[0], out[out.length - 1])) out.pop()
  return out
}

/** The runs of consecutive items `inRun` says yes to, in order; a run that
 *  wraps round past the last item joins the first. */
function runsOf(items, inRun) {
  const runs = []
  let cur = null
  for (const q of items) {
    if (inRun(q)) (cur ??= []).push(q)
    else if (cur) {
      runs.push(cur)
      cur = null
    }
  }
  if (cur) {
    if (runs.length > 0 && inRun(items[0])) runs[0] = [...cur, ...runs[0]]
    else runs.push(cur)
  }
  return runs
}

/** The middle of points, on XY. */
const middle = (pts) => [mean(pts.map((p) => p[0])), mean(pts.map((p) => p[1]))]

/** The circle through points on the XY plane, least squares (Kåsa). */
function fitCircle(pts) {
  const [mx, my] = [mean(pts.map((p) => p[0])), mean(pts.map((p) => p[1]))]
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0
  for (const p of pts) {
    const u = p[0] - mx, v = p[1] - my
    suu += u * u; svv += v * v; suv += u * v
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u
  }
  const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2
  const det = suu * svv - suv * suv
  const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det
  const c = [mx + uc, my + vc]
  return { c, r: mean(pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]))) }
}

/** The rings of a section — chains closed, or whose ends nearly meet (a
 *  scan's gap leaves a ring open) — world points, longest first. */
async function chainsOf(call, section, { open = false } = {}) {
  // Within what an MCP answer carries (40 k characters): every k-th point
  // past it, which still draws each tooth with dozens.
  const got = await call('section.get', { section, space: 'world', limit: 1200 })
  const ring = (c) => {
    if (c.closed) return true
    const a = c.world[0]
    const b = c.world[c.world.length - 1]
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.05 * c.length
  }
  return got.chains
    .filter((c) => open || ring(c))
    .sort((a, b) => b.length - a.length)
    .map((c) => c.world)
}

/** A section square to Z at `z`, named — a reading aid, removed again
 *  when the model is built (`cut` keeps their names). */
const cutAt = async (call, z, name, cut) => {
  await call('section.cut', { across: 'XY', offset: z, name })
  cut.push(name)
}

/**
 * Model the gear. Returns what was read and built: teeth, tip, root, bore
 * and hub radii, the heights, the feature names, and the compare's score.
 */
export async function buildGear(call, { log = () => {} } = {}) {
  // The sections cut to read the scan, by name: removed once it is read.
  const cut = []
  // ---- stand it on its axis ------------------------------------------------------
  // Square to its largest flat face, exactly — the gear's face — the rest
  // settled about it: the axis is that face's normal.
  const aligned = await call('align.auto', { level: 'largest' })
  const zFaces = (aligned.square?.axes?.find((a) => a.axis === 'z')?.faces ?? []).slice().sort((a, b) => a.center[2] - b.center[2])
  if (zFaces.length < 2) throw new Error(`align.auto found ${zFaces.length} faces square to Z — not a gear standing on its axis`)
  // The base, the face it stands on; the top, the scan's highest point; the
  // teeth stop at the largest face above the base below the top (the
  // gear's face), or at the top with no hub.
  const bounds = (await call('session.state', {})).scan.bounds
  let bottom = zFaces[0].center[2]
  const top = bounds.max[2]
  const above = zFaces.slice(1)
  let teethTop = above.length > 0 ? above.reduce((a, b) => (b.area > a.area ? b : a)).center[2] : top
  log(`faces square to Z at ${zFaces.map((f) => f.center[2].toFixed(2)).join(', ')}; teeth ${bottom.toFixed(2)}…${teethTop.toFixed(2)}, top ${top.toFixed(2)}`)

  // ---- the teeth, off a section through them -------------------------------------
  const zTeeth = (bottom + teethTop) / 2
  await cutAt(call, zTeeth, 'Teeth', cut)
  // The teeth as the reader sees them — its count and envelopes, for the
  // record; the model takes its numbers off the outline about the bore's
  // centre, which a closed ring of teeth reads more surely.
  const fit = await call('reverse.section.fit', { section: 'Teeth', periodic: true, brief: true })
  const read = fit.chains.map((c) => c.periodic).filter((p) => p && p.teeth >= 3).sort((a, b) => b.teeth - a.teeth)[0] ?? null
  const chains = await chainsOf(call, 'Teeth')
  if (chains.length < 1) throw new Error('the section through the teeth has no closed outline')
  const outline = chains[0]
  // The axis: the bore's centre, a circle fitted to the innermost ring;
  // without a bore, the outline's own middle.
  const rough = middle(outline)
  const rings = chains.slice(1).map((c) => ({ c, r: mean(c.map((p) => Math.hypot(p[0] - rough[0], p[1] - rough[1]))), off: Math.hypot(middle(c)[0] - rough[0], middle(c)[1] - rough[1]) }))
  const boreRing = rings.filter((x) => x.off < x.r).sort((a, b) => a.r - b.r)[0] ?? null
  const circle = boreRing ? fitCircle(boreRing.c) : null
  // The bore's points read so far, the hub's added below: its circle,
  // fitted over both heights, is the one cut.
  const boreRings = boreRing ? [...boreRing.c] : []
  const centre = circle ? circle.c : rough
  const bore = circle ? circle.r : null
  const polar = outline.map((p) => ({ p, a: Math.atan2(p[1] - centre[1], p[0] - centre[0]), r: Math.hypot(p[0] - centre[0], p[1] - centre[1]) }))
  const rMax = Math.max(...polar.map((q) => q.r))
  const rMin = Math.min(...polar.map((q) => q.r))
  let mid = (rMax + rMin) / 2

  // ---- the teeth: the runs of the outline past the middle ------------------------
  const n = polar.length
  const runsAbove = (m) => {
    const start = polar.findIndex((q, i) => q.r < m && polar[(i + 1) % n].r >= m)
    if (start < 0) return []
    const runs = []
    let cur = null
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n
      if (polar[i].r >= m) (cur ??= []).push(i)
      else if (cur) {
        runs.push(cur)
        cur = null
      }
    }
    if (cur) runs.push(cur)
    return runs
  }
  let runs = runsAbove(mid)
  const tip = median(runs.map((run) => Math.max(...run.map((i) => polar[i].r))))
  // The root: the least radius between each tooth and the next.
  const gaps = runs.map((run, k) => {
    const next = runs[(k + 1) % runs.length]
    let lo = Infinity
    for (let i = (run[run.length - 1] + 1) % n; i !== next[0]; i = (i + 1) % n) lo = Math.min(lo, polar[i].r)
    return lo
  })
  const root = median(gaps.filter(Number.isFinite))
  mid = (tip + root) / 2
  runs = runsAbove(mid)
  const teeth = runs.length
  log(`${teeth} teeth (the reader: ${read?.teeth ?? '—'}), tip r ${tip.toFixed(3)}, root r ${root.toFixed(3)}, bore r ${bore?.toFixed(3) ?? '—'} about [${centre.map((v) => v.toFixed(3))}]`)

  // ---- the faces' heights, off the points on them --------------------------------
  // A face's height: the median of the points on it facing its way, in a
  // ring where nothing else lies — the teeth's own faces for the base and
  // the gear's face.
  const faceAt = async (z, up, r0, r1) => {
    const got = await call('scan.query', { box: { min: [centre[0] - r1, centre[1] - r1, z - 1], max: [centre[0] + r1, centre[1] + r1, z + 1] }, normal: { dir: [0, 0, up ? 1 : -1], withinDeg: 10 }, limit: 600 })
    const zs = (got.points ?? []).filter((p) => {
      const r = Math.hypot(p[0] - centre[0], p[1] - centre[1])
      return r > r0 && r < r1
    }).map((p) => p[2])
    return zs.length >= 20 ? median(zs) : z
  }
  // The base read over all of it, bore to tip: one face, where a scan
  // that stands a little higher under its teeth than inside lies best.
  bottom = await faceAt(bottom, false, (bore ?? 0) + 0.4, tip - 0.5)
  teethTop = await faceAt(teethTop, true, root + 0.5, tip - 0.5)
  log(`faces at ${bottom.toFixed(3)} (base) and ${teethTop.toFixed(3)} (gear's face), off the points`)

  // ---- one tooth off the outline -------------------------------------------------
  // The tooth nearest +u, widened down to just above the root on each side.
  const low = root + 0.15 * (tip - root)
  const angleOf = (run) => polar[run[run.length >> 1]].a
  const run = runs.reduce((a, b) => (Math.abs(angleOf(b)) < Math.abs(angleOf(a)) ? b : a))
  let a0 = run[0]
  let a1 = run[run.length - 1]
  while (polar[(a0 - 1 + n) % n].r > low && a0 !== a1) a0 = (a0 - 1 + n) % n
  while (polar[(a1 + 1) % n].r > low && a1 !== a0) a1 = (a1 + 1) % n
  const idx = []
  for (let i = a0; ; i = (i + 1) % n) {
    idx.push(i)
    if (i === a1) break
  }
  const step = Math.max(1, Math.ceil(idx.length / 24))
  const kept = idx.filter((_, k) => k % step === 0 || k === idx.length - 1)
  // Closed inward, under the root circle, so the tooth and the circle overlap.
  const inside = (q) => [centre[0] + (root - 1) * Math.cos(q.a), centre[1] + (root - 1) * Math.sin(q.a), zTeeth]
  const tooth = [inside(polar[a0]), ...kept.map((i) => [polar[i].p[0], polar[i].p[1], zTeeth]), inside(polar[a1])]

  // ---- the model -----------------------------------------------------------------
  const plane = { kind: 'world', axis: 'z', offset: bottom }
  const TOOTH = 10
  await call('reverse.feature.add', {
    feature: {
      kind: 'sketch',
      name: 'Gear profile',
      plane,
      sketch: {
        shapes: [
          { kind: 'circle', id: 1, world: true, fixed: true, center: [centre[0], centre[1], bottom], radius: root },
          { kind: 'polyline', id: TOOTH, world: true, fixed: true, closed: true, points: tooth },
        ],
        patterns: [{ kind: 'circular', pieces: tooth.map((_, k) => TOOTH + k), center: [centre[0], centre[1]], count: teeth }],
      },
    },
  })
  const body = await call('reverse.feature.add', { feature: { kind: 'extrude', name: 'Gear', sketchId: 'Gear profile', regions: 'all', extent: { kind: 'distance', from: 0, to: teethTop - bottom }, op: 'new' } })
  if (body.result?.status !== 'ok') throw new Error(`the gear's extrude: ${body.result?.message ?? body.result?.status}`)
  const features = ['Gear profile', 'Gear']

  // ---- the hub and its lugs ------------------------------------------------------
  // The hub's top: the highest face square to Z, where it stands clear of
  // the teeth; else the scan's top.
  const highest = zFaces[zFaces.length - 1].center[2]
  let hubTop = zFaces.length >= 3 && highest > teethTop + 1 ? highest : top
  let hub = null
  const lugs = []
  if (hubTop - teethTop > 1) {
    // Read near its top, clear of a hole through its side: every run of the
    // cut outside the bore, laid round the axis by angle — a hub's top is
    // often scanned in pieces.
    await cutAt(call, hubTop - Math.min(1.5, (hubTop - teethTop) / 4), 'Hub', cut)
    const hubCut = (await chainsOf(call, 'Hub', { open: true })).flat()
    boreRings.push(...hubCut.filter((p) => Math.abs(Math.hypot(p[0] - centre[0], p[1] - centre[1]) - (bore ?? 0)) < 0.5))
    const around = hubCut
      .map((p) => ({ p, a: Math.atan2(p[1] - centre[1], p[0] - centre[0]), r: Math.hypot(p[0] - centre[0], p[1] - centre[1]) }))
      .filter((q) => q.r > (bore ?? 0) + 1)
      .sort((x, y) => x.a - y.a)
    if (around.length < 16) throw new Error('the section through the hub cut nothing outside the bore')
    // The hub's radius: the median of its round, the lugs left out.
    const rough = median(around.map((q) => q.r))
    // Its own centre and radius, a circle fitted to its round, the lugs
    // left out — a hub need not stand quite on the bore's axis.
    // Fitted twice: the points more than 0.3 mm off the first left out (a
    // lug's flank, a chamfer cut into the section).
    const ring = around.filter((q) => Math.abs(q.r - rough) < 0.8).map((q) => q.p)
    const first = fitCircle(ring)
    const round = fitCircle(ring.filter((p) => Math.abs(Math.hypot(p[0] - first.c[0], p[1] - first.c[1]) - first.r) < 0.3))
    const hubC = round.c
    hub = round.r
    hubTop = await faceAt(hubTop, true, (bore ?? 0) + 1, hub - 0.5)
    // A lug: a run of the outline standing out of the hub by over 0.8 mm,
    // closed inward under the hub's circle so the two overlap.
    const into = (a) => [hubC[0] + (hub - 1) * Math.cos(a), hubC[1] + (hub - 1) * Math.sin(a)]
    for (const run of runsOf(around, (q) => q.r > hub + 0.8)) {
      if (run.length < 6) continue
      lugs.push([into(run[0].a), ...decimate(run.map((q) => q.p), 32).map((p) => [p[0], p[1]]), into(run[run.length - 1].a)])
    }
    log(`hub r ${hub.toFixed(3)}, ${teethTop.toFixed(2)}…${hubTop.toFixed(2)}, ${lugs.length} lug${lugs.length === 1 ? '' : 's'}`)
    const LUG = 100
    await call('reverse.feature.add', {
      feature: {
        kind: 'sketch',
        name: 'Hub profile',
        plane: { kind: 'world', axis: 'z', offset: teethTop },
        sketch: {
          shapes: [
            { kind: 'circle', id: 1, world: true, fixed: true, center: [hubC[0], hubC[1], teethTop], radius: hub },
            ...lugs.map((pts, k) => ({ kind: 'polyline', id: LUG * (k + 1), world: true, fixed: true, closed: true, points: pts.map((p) => [p[0], p[1], teethTop]) })),
          ],
        },
      },
    })
    const made = await call('reverse.feature.add', { feature: { kind: 'extrude', name: 'Hub', sketchId: 'Hub profile', regions: 'all', extent: { kind: 'distance', from: -0.5, to: hubTop - teethTop }, op: 'join' } })
    if (made.result?.status !== 'ok') throw new Error(`the hub's extrude: ${made.result?.message ?? made.result?.status}`)
    features.push('Hub profile', 'Hub')
  }

  // ---- pockets in the base -------------------------------------------------------
  // Closed outlines a little above the base, between the bore and the root:
  // pockets cut into the base, regular round the axis.
  const zLow = bottom + 1.5
  // The cut's runs between the bore and the root, open ones too.
  const baseRuns = async (z, open) => {
    const name = `Base ${z.toFixed(2)}`
    await cutAt(call, z, name, cut)
    return (await chainsOf(call, name, { open })).filter((c) => {
      const [mx, my] = middle(c)
      const r = Math.hypot(mx - centre[0], my - centre[1])
      return r > (bore ?? 0) + 1 && r < root - 1 && c.length >= (open ? 2 : 8)
    })
  }
  const pockets = await baseRuns(zLow, false)
  let pocket = null
  if (pockets.length >= 2) {
    // How many: round the axis at the spacing the ones seen whole keep — a
    // pocket the scan leaves open is one all the same.
    const angles = pockets.map((c) => Math.atan2(middle(c)[1] - centre[1], middle(c)[0] - centre[0])).sort((x, y) => x - y)
    const steps = angles.map((a, k) => (k + 1 < angles.length ? angles[k + 1] - a : angles[0] + 2 * Math.PI - a))
    const count = Math.round((2 * Math.PI) / median(steps))
    // How deep: as far as the scan sees their walls — a narrow pocket's
    // floor is seldom scanned. Sections stepped up by half millimetres
    // until the walls are gone, then by tenths.
    const walls = async (z) => (await baseRuns(z, true)).length > 0
    let depth = zLow
    for (let z = zLow + 0.5; z < teethTop - 0.5 && (await walls(z)); z += 0.5) depth = z
    for (let z = depth + 0.1; z < depth + 0.45 && (await walls(z)); z += 0.1) depth = z
    const template = pockets.reduce((a, b) => (b.length > a.length ? b : a))
    const outline = decimate(template, 40)
    const POCKET = 10
    await call('reverse.feature.add', {
      feature: {
        kind: 'sketch',
        name: 'Pocket profile',
        plane,
        sketch: {
          shapes: [{ kind: 'polyline', id: POCKET, world: true, fixed: true, closed: true, points: outline.map((p) => [p[0], p[1], bottom]) }],
          patterns: [{ kind: 'circular', pieces: outline.map((_, k) => POCKET + k), center: [centre[0], centre[1]], count }],
        },
      },
    })
    const cut = await call('reverse.feature.add', { feature: { kind: 'extrude', name: 'Pockets', sketchId: 'Pocket profile', regions: 'all', extent: { kind: 'distance', from: -1, to: depth - bottom }, op: 'cut' } })
    if (cut.result?.status !== 'ok') throw new Error(`the pockets' cut: ${cut.result?.message ?? cut.result?.status}`)
    features.push('Pocket profile', 'Pockets')
    pocket = { count, depth: depth - bottom }
    log(`${count} pockets (${pockets.length} seen whole), ${pocket.depth.toFixed(2)} deep — as deep as the scan sees their walls`)
  }

  if (bore) {
    const whole = fitCircle(boreRings)
    log(`bore r ${whole.r.toFixed(3)} about [${whole.c.map((v) => v.toFixed(3))}], over ${boreRings.length} points at two heights`)
    await call('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Bore profile', plane, sketch: { shapes: [{ kind: 'circle', id: 1, world: true, fixed: true, center: [whole.c[0], whole.c[1], bottom], radius: whole.r }] } },
    })
    const cut = await call('reverse.feature.add', { feature: { kind: 'extrude', name: 'Bore', sketchId: 'Bore profile', regions: 'all', extent: { kind: 'distance', from: -1, to: hubTop - bottom + 1 }, op: 'cut' } })
    if (cut.result?.status !== 'ok') throw new Error(`the bore's cut: ${cut.result?.message ?? cut.result?.status}`)
    features.push('Bore profile', 'Bore')
  }

  // ---- the bore's mouth ----------------------------------------------------------
  // A countersink where the bore meets the hub's top: the top's points
  // read in rings from the bore out, each ring's median height; the sink
  // runs out where the top is level again.
  let sink = null
  if (bore && hub) {
    const whole = fitCircle(boreRings)
    const got = await call('scan.query', { box: { min: [whole.c[0] - hub, whole.c[1] - hub, hubTop - 3], max: [whole.c[0] + hub, whole.c[1] + hub, hubTop + 0.5] }, normal: { dir: [0, 0, 1], withinDeg: 75 }, limit: 1000 })
    const pts = (got.points ?? []).map((q) => ({ r: Math.hypot(q[0] - whole.c[0], q[1] - whole.c[1]), z: q[2] }))
    const rings = []
    for (let r0 = whole.r; r0 < hub - 0.6; r0 += 0.3) {
      const zs = pts.filter((q) => q.r >= r0 && q.r < r0 + 0.3).map((q) => q.z)
      if (zs.length >= 8) rings.push({ r: r0 + 0.15, z: median(zs) })
    }
    const level = rings.findIndex((q) => q.z > hubTop - 0.08)
    if (level >= 2 && rings[0].z < hubTop - 0.3) {
      const slope = rings.slice(0, level)
      // A line through the sloping rings, read at the bore and at the top.
      const mr = mean(slope.map((q) => q.r))
      const mz = mean(slope.map((q) => q.z))
      const k = slope.reduce((a, q) => a + (q.r - mr) * (q.z - mz), 0) / slope.reduce((a, q) => a + (q.r - mr) ** 2, 0)
      if (k > 0.05) {
        const atBore = mz + k * (whole.r - mr)
        const outer = mr + (hubTop - mz) / k
        sink = { depth: hubTop - atBore, width: outer - whole.r }
        const [cx, cy] = whole.c
        await call('reverse.feature.add', {
          feature: {
            kind: 'sketch',
            name: 'Countersink profile',
            plane: { kind: 'world', axis: 'y', offset: cy },
            sketch: {
              shapes: [
                { kind: 'polyline', id: 1, world: true, fixed: true, closed: true, points: [[cx + whole.r - 0.5, cy, atBore - 0.5 * k], [cx + outer + 0.5 / k, cy, hubTop + 0.5], [cx + whole.r - 0.5, cy, hubTop + 0.5]] },
                { kind: 'polyline', id: 10, world: true, fixed: true, construction: true, points: [[cx, cy, hubTop - 5], [cx, cy, hubTop + 1]] },
              ],
            },
          },
        })
        const made = await call('reverse.feature.add', { feature: { kind: 'revolve', name: 'Countersink', sketchId: 'Countersink profile', axis: { kind: 'sketchLine', entity: 10 }, op: 'cut' } })
        if (made.result?.status !== 'ok') throw new Error(`the countersink: ${made.result?.message ?? made.result?.status}`)
        features.push('Countersink profile', 'Countersink')
        log(`countersink ${sink.width.toFixed(2)} wide, ${sink.depth.toFixed(2)} deep`)
      }
    }
  }

  // The sections cut to read the scan go: the model stands on its own.
  for (const name of cut) await call('section.remove', { section: name })
  const compare = await call('reverse.body.compare', { detail: 'score' })
  log(`compare: ${JSON.stringify(compare).slice(0, 400)}`)
  return { teeth, read: read?.teeth ?? null, tip, root, bore, hub, lugs: lugs.length, pocket, sink, centre, bottom, teethTop, top: hubTop, features, compare }
}
