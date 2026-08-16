// SPDX-License-Identifier: AGPL-3.0-only
// Hand-built AP214 B-reps with exactly known geometry, so the STEP import can
// be checked against the shape it is supposed to be reproducing rather than
// against a golden mesh. Written out here instead of committed as fixture
// files: the dimensions the tests assert are the ones the builders take.

/** Accumulates `#n=ENTITY(...)` records and hands back their references. */
class Part21 {
  private lines: string[] = []
  private n = 0

  put(entity: string): string {
    this.lines.push(`#${++this.n}=${entity};`)
    return `#${this.n}`
  }

  num(v: number): string {
    return Number.isInteger(v) ? `${v}.` : String(v)
  }

  point(p: readonly number[]): string {
    return this.put(`CARTESIAN_POINT('',(${p.map((c) => this.num(c)).join(',')}))`)
  }

  direction(d: readonly number[]): string {
    return this.put(`DIRECTION('',(${d.map((c) => this.num(c)).join(',')}))`)
  }

  axis(origin: readonly number[], axis: readonly number[], ref: readonly number[]): string {
    return this.put(
      `AXIS2_PLACEMENT_3D('',${this.point(origin)},${this.direction(axis)},${this.direction(ref)})`,
    )
  }

  /** Wrap a solid in the units, context and product structure a real exporter
   *  writes, and emit the file. */
  finish(brepName: string, shell: string, description: string, fileName: string): string {
    const origin = this.axis([0, 0, 0], [0, 0, 1], [1, 0, 0])
    const brep = this.put(`MANIFOLD_SOLID_BREP('${brepName}',${shell})`)

    const mm = this.put(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`)
    const rad = this.put(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`)
    const sr = this.put(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`)
    const tol = this.put(
      `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${mm},'distance_accuracy_value','')`,
    )
    const ctx = this.put(
      `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${tol}))` +
        `GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr}))REPRESENTATION_CONTEXT('',''))`,
    )
    const rep = this.put(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${origin},${brep}),${ctx})`)

    const app = this.put(`APPLICATION_CONTEXT('automotive design')`)
    this.put(
      `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${app})`,
    )
    const pctx = this.put(`PRODUCT_CONTEXT('',${app},'mechanical')`)
    const product = this.put(`PRODUCT('${brepName}','${brepName}','',(${pctx}))`)
    const pdf = this.put(
      `PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',${product},.NOT_KNOWN.)`,
    )
    const pdctx = this.put(`PRODUCT_DEFINITION_CONTEXT('part definition',${app},'design')`)
    const pd = this.put(`PRODUCT_DEFINITION('design','',${pdf},${pdctx})`)
    const pds = this.put(`PRODUCT_DEFINITION_SHAPE('','',${pd})`)
    this.put(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`)

    return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('${description}'),'2;1');
FILE_NAME('${fileName}','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
${this.lines.join('\n')}
ENDSEC;
END-ISO-10303-21;
`
  }
}

/** A cube of side `size` with one corner at the origin: six planar faces, all
 *  twelve edges shared between the two faces that meet along them. */
export function cubeStep(size = 20): string {
  const s = new Part21()
  const S = size
  const P = [
    [0, 0, 0],
    [S, 0, 0],
    [S, S, 0],
    [0, S, 0],
    [0, 0, S],
    [S, 0, S],
    [S, S, S],
    [0, S, S],
  ]
  const vertex = P.map((p) => s.put(`VERTEX_POINT('',${s.point(p)})`))

  // Every edge once, low vertex index to high; the faces pick their direction
  // with the ORIENTED_EDGE sense flag.
  const E: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [0, 3],
    [4, 5], [5, 6], [6, 7], [4, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ]
  const curve = E.map(([a, b]) => {
    const d = [P[b][0] - P[a][0], P[b][1] - P[a][1], P[b][2] - P[a][2]]
    const len = Math.hypot(d[0], d[1], d[2])
    const line = s.put(
      `LINE('',${s.point(P[a])},${s.put(`VECTOR('',${s.direction(d.map((c) => c / len))},${s.num(len)})`)})`,
    )
    return s.put(`EDGE_CURVE('',${vertex[a]},${vertex[b]},${line},.T.)`)
  })
  const index = new Map(E.map(([a, b], i) => [`${a}-${b}`, i]))

  // Loops wound counter-clockwise seen from outside the solid, so the face
  // normals agree with the plane normals and same_sense can stay .T.
  const faces = [
    { loop: [0, 3, 2, 1], org: [0, 0, 0], axis: [0, 0, -1], ref: [1, 0, 0] },
    { loop: [4, 5, 6, 7], org: [0, 0, S], axis: [0, 0, 1], ref: [1, 0, 0] },
    { loop: [0, 1, 5, 4], org: [0, 0, 0], axis: [0, -1, 0], ref: [1, 0, 0] },
    { loop: [1, 2, 6, 5], org: [S, 0, 0], axis: [1, 0, 0], ref: [0, 1, 0] },
    { loop: [2, 3, 7, 6], org: [0, S, 0], axis: [0, 1, 0], ref: [-1, 0, 0] },
    { loop: [3, 0, 4, 7], org: [0, 0, 0], axis: [-1, 0, 0], ref: [0, -1, 0] },
  ].map((f) => {
    const oriented = f.loop.map((a, i) => {
      const b = f.loop[(i + 1) % f.loop.length]
      const forward = index.has(`${a}-${b}`)
      const id = curve[(forward ? index.get(`${a}-${b}`) : index.get(`${b}-${a}`))!]
      return s.put(`ORIENTED_EDGE('',*,*,${id},${forward ? '.T.' : '.F.'})`)
    })
    const bound = s.put(
      `FACE_OUTER_BOUND('',${s.put(`EDGE_LOOP('',(${oriented.join(',')}))`)},.T.)`,
    )
    const plane = s.put(`PLANE('',${s.axis(f.org, f.axis, f.ref)})`)
    return s.put(`ADVANCED_FACE('',(${bound}),${plane},.T.)`)
  })

  return s.finish(
    'cube',
    s.put(`CLOSED_SHELL('',(${faces.join(',')}))`),
    `${S} mm cube`,
    'cube.step',
  )
}

/** A solid cylinder about +Z, base at z = 0: two planar caps and one
 *  cylindrical face, the caps' rims shared with it as bare closed circles. */
export function cylinderStep(radius = 10, height = 30): string {
  const s = new Part21()
  const vb = s.put(`VERTEX_POINT('',${s.point([radius, 0, 0])})`)
  const vt = s.put(`VERTEX_POINT('',${s.point([radius, 0, height])})`)
  const circleB = s.put(`CIRCLE('',${s.axis([0, 0, 0], [0, 0, 1], [1, 0, 0])},${s.num(radius)})`)
  const circleT = s.put(
    `CIRCLE('',${s.axis([0, 0, height], [0, 0, 1], [1, 0, 0])},${s.num(radius)})`,
  )
  const edgeB = s.put(`EDGE_CURVE('',${vb},${vb},${circleB},.T.)`)
  const edgeT = s.put(`EDGE_CURVE('',${vt},${vt},${circleT},.T.)`)
  const loop = (edge: string, sense: string) =>
    s.put(`EDGE_LOOP('',(${s.put(`ORIENTED_EDGE('',*,*,${edge},${sense})`)}))`)

  const bottom = s.put(
    `ADVANCED_FACE('',(${s.put(`FACE_OUTER_BOUND('',${loop(edgeB, '.F.')},.T.)`)}),` +
      `${s.put(`PLANE('',${s.axis([0, 0, 0], [0, 0, -1], [1, 0, 0])})`)},.T.)`,
  )
  const top = s.put(
    `ADVANCED_FACE('',(${s.put(`FACE_OUTER_BOUND('',${loop(edgeT, '.T.')},.T.)`)}),` +
      `${s.put(`PLANE('',${s.axis([0, 0, height], [0, 0, 1], [1, 0, 0])})`)},.T.)`,
  )
  const side = s.put(
    `ADVANCED_FACE('',(${s.put(`FACE_OUTER_BOUND('',${loop(edgeB, '.T.')},.T.)`)},` +
      `${s.put(`FACE_BOUND('',${loop(edgeT, '.F.')},.T.)`)}),` +
      `${s.put(`CYLINDRICAL_SURFACE('',${s.axis([0, 0, 0], [0, 0, 1], [1, 0, 0])},${s.num(radius)})`)},.T.)`,
  )

  return s.finish(
    'cylinder',
    s.put(`CLOSED_SHELL('',(${bottom},${top},${side}))`),
    `r${radius} h${height} cylinder`,
    'cylinder.step',
  )
}

export function stepBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
