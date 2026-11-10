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

/** A section square to Z at `z`, named. */
const cutAt = (call, z, name) => call('section.cut', { across: 'XY', offset: z, name })

/**
 * Model the gear. Returns what was read and built: teeth, tip, root, bore
 * and hub radii, the heights, the feature names, and the compare's score.
 */
export async function buildGear(call, { log = () => {} } = {}) {
  // ---- stand it on its axis ------------------------------------------------------
  const aligned = await call('align.auto', {})
  const zFaces = (aligned.square?.axes?.find((a) => a.axis === 'z')?.faces ?? []).slice().sort((a, b) => a.center[2] - b.center[2])
  if (zFaces.length < 2) throw new Error(`align.auto found ${zFaces.length} faces square to Z — not a gear standing on its axis`)
  // The base, the face it stands on; the top, the scan's highest point; the
  // teeth stop at the largest face above the base below the top (the
  // gear's face), or at the top with no hub.
  const bounds = (await call('session.state', {})).scan.bounds
  const bottom = zFaces[0].center[2]
  const top = bounds.max[2]
  const above = zFaces.slice(1)
  const teethTop = above.length > 0 ? above.reduce((a, b) => (b.area > a.area ? b : a)).center[2] : top
  log(`faces square to Z at ${zFaces.map((f) => f.center[2].toFixed(2)).join(', ')}; teeth ${bottom.toFixed(2)}…${teethTop.toFixed(2)}, top ${top.toFixed(2)}`)

  // ---- the teeth, off a section through them -------------------------------------
  const zTeeth = (bottom + teethTop) / 2
  await cutAt(call, zTeeth, 'Teeth')
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
  const middle = (pts) => [mean(pts.map((p) => p[0])), mean(pts.map((p) => p[1]))]
  const rough = middle(outline)
  const rings = chains.slice(1).map((c) => ({ c, r: mean(c.map((p) => Math.hypot(p[0] - rough[0], p[1] - rough[1]))), off: Math.hypot(middle(c)[0] - rough[0], middle(c)[1] - rough[1]) }))
  const boreRing = rings.filter((x) => x.off < x.r).sort((a, b) => a.r - b.r)[0] ?? null
  const circle = boreRing ? fitCircle(boreRing.c) : null
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

  let hub = null
  if (top - teethTop > 1) {
    await cutAt(call, (teethTop + top) / 2, 'Hub')
    // The hub's outside: the longest run of the cut outside the bore, open
    // or closed — the top of a hub is often scanned in pieces, and a lug or
    // a rib on it cuts short runs further out.
    const hubChains = await chainsOf(call, 'Hub', { open: true })
    const outside = hubChains
      .map((c) => ({ n: c.length, r: median(c.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1]))) }))
      .filter((c) => c.r > (bore ?? 0) + 1)
    if (outside.length === 0) throw new Error('the section through the hub cut nothing outside the bore')
    hub = outside.reduce((a, b) => (b.n > a.n ? b : a)).r
    await call('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Hub profile', plane: { kind: 'world', axis: 'z', offset: teethTop }, sketch: { shapes: [{ kind: 'circle', id: 1, world: true, fixed: true, center: [centre[0], centre[1], teethTop], radius: hub }] } },
    })
    const made = await call('reverse.feature.add', { feature: { kind: 'extrude', name: 'Hub', sketchId: 'Hub profile', regions: 'all', extent: { kind: 'distance', from: -0.5, to: top - teethTop }, op: 'join' } })
    if (made.result?.status !== 'ok') throw new Error(`the hub's extrude: ${made.result?.message ?? made.result?.status}`)
    features.push('Hub profile', 'Hub')
    log(`hub r ${hub.toFixed(3)}, ${teethTop.toFixed(2)}…${top.toFixed(2)}`)
  }
  if (bore) {
    await call('reverse.feature.add', {
      feature: { kind: 'sketch', name: 'Bore profile', plane, sketch: { shapes: [{ kind: 'circle', id: 1, world: true, fixed: true, center: [centre[0], centre[1], bottom], radius: bore }] } },
    })
    const cut = await call('reverse.feature.add', { feature: { kind: 'extrude', name: 'Bore', sketchId: 'Bore profile', regions: 'all', extent: { kind: 'distance', from: -1, to: top - bottom + 1 }, op: 'cut' } })
    if (cut.result?.status !== 'ok') throw new Error(`the bore's cut: ${cut.result?.message ?? cut.result?.status}`)
    features.push('Bore profile', 'Bore')
  }

  const compare = await call('reverse.body.compare', { detail: 'score' })
  log(`compare: ${JSON.stringify(compare).slice(0, 400)}`)
  return { teeth, read: read?.teeth ?? null, tip, root, bore, hub, centre, bottom, teethTop, top, features, compare }
}
