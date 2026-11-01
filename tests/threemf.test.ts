// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { build3mf, weldExact } from '../src/core/export3mf'
import { buildMeshFile } from '../src/core/exportMesh'
import { parse3MF } from '../src/core/parsers/threemf'
import { parseSTL } from '../src/core/parsers/stl'
import { scanCompanions } from '../src/app/scanFiles'

/** A unit cube as a triangle soup: twelve triangles, each corner its own
 *  vertex — how an STL lays a mesh out. */
function cubeSoup(): Float32Array {
  const quads = [
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  ]
  const out: number[] = []
  for (const [a, b, c, d] of quads) out.push(...a, ...b, ...c, ...a, ...c, ...d)
  return Float32Array.from(out)
}

const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'

/** A package of the given files, the root model at 3D/3dmodel.model. */
const pack = (files: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries([['_rels/.rels', strToU8(RELS)], ...Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])])).buffer as ArrayBuffer

const TRIANGLE = '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>'

const model = (body: string, unit = 'millimeter') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">${body}</model>`

describe('3MF export', () => {
  it('welds a soup into a closed mesh and drops what the weld collapses', () => {
    const soup = cubeSoup()
    const w = weldExact(soup, null)
    expect(w.vertices.length / 3).toBe(8)
    expect(w.triangles.length / 3).toBe(12)
    const collapsed = weldExact(Float32Array.of(0, 0, 0, 0, 0, 0, 1, 0, 0), null)
    expect(collapsed.triangles.length).toBe(0)
    // -0 and 0 are one place.
    expect(weldExact(Float32Array.of(-0, 0, 0, 0, 0, 0, 1, 0, 0), null).vertices.length / 3).toBe(2)
  })

  it('writes a package that says millimetres and reads back the same', () => {
    const built = build3mf([{ name: 'cube & co', positions: cubeSoup(), indices: null }], null, 'A <title>')!
    expect(built.triangles).toBe(12)
    const files = unzipSync(built.bytes)
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels'])
    const xml = strFromU8(files['3D/3dmodel.model'])
    expect(xml).toContain('unit="millimeter"')
    expect(xml).toContain('name="cube &amp; co"')
    expect(xml).toContain('A &lt;title&gt;')
    expect(xml).not.toContain('colorgroup')
    const back = parse3MF(built.bytes.slice().buffer)
    expect(back.positions.length / 3).toBe(8)
    expect(back.indices!.length / 3).toBe(12)
    expect(back.colors).toBeUndefined()
  })

  it('carries a part’s colours, and each part as an object of its own', () => {
    const soup = cubeSoup()
    const colors = new Uint8Array(soup.length)
    for (let i = 0; i < soup.length / 3; i++) colors.set(soup[i * 3] > 0.5 ? [200, 30, 30] : [30, 30, 200], i * 3)
    const moved = soup.map((v, i) => (i % 3 === 0 ? v + 5 : v))
    const built = build3mf(
      [
        { name: 'a', positions: soup, indices: null, colors },
        { name: 'b', positions: moved, indices: null },
      ],
      null,
      'two',
    )!
    const xml = strFromU8(unzipSync(built.bytes)['3D/3dmodel.model'])
    expect(xml.match(/<object /g)).toHaveLength(2)
    expect(xml.match(/<item /g)).toHaveLength(2)
    expect(xml.match(/<m:color /g)).toHaveLength(2)
    const back = parse3MF(built.bytes.slice().buffer)
    expect(back.indices!.length / 3).toBe(24)
    // The red side of the first cube is red; the second cube, colourless,
    // takes the grey of a vertex no colour reaches.
    const at = (x: number, y: number, z: number) => {
      for (let i = 0; i < back.positions.length / 3; i++) {
        if (back.positions[i * 3] === x && back.positions[i * 3 + 1] === y && back.positions[i * 3 + 2] === z) return [...back.colors!.subarray(i * 3, i * 3 + 3)]
      }
      return null
    }
    expect(at(1, 1, 1)).toEqual([200, 30, 30])
    expect(at(0, 0, 0)).toEqual([30, 30, 200])
    expect(at(6, 1, 1)).toEqual([180, 180, 180])
  })

  it('moves the vertices by the transform on the way out', () => {
    const transform = { r: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), t: Float64Array.of(10, 0, 0) }
    const built = build3mf([{ name: 'a', positions: cubeSoup(), indices: null }], transform, 't')!
    const back = parse3MF(built.bytes.slice().buffer)
    expect(Math.min(...Array.from(back.positions).filter((_, i) => i % 3 === 0))).toBe(10)
  })

  it('writes an STL of several parts as one mesh', () => {
    const stl = buildMeshFile('stl', [{ name: 'a', positions: cubeSoup(), indices: null }, { name: 'b', positions: cubeSoup(), indices: null }], null, 'x')!
    expect(stl.extension).toBe('stl')
    expect(stl.triangles).toBe(24)
    expect(parseSTL(stl.bytes.slice().buffer).positions.length / 9).toBe(24)
    expect(buildMeshFile('3mf', [{ name: 'a', positions: new Float32Array(0), indices: null }], null, 'x')).toBeNull()
  })
})

describe('3MF import', () => {
  it('refuses components that multiply past what can be opened', () => {
    // Each object holds the one before it twice: thirty levels would place
    // the triangle at the bottom 2^30 times.
    const objects = [`<object id="1" type="model">${TRIANGLE}</object>`]
    for (let id = 2; id <= 30; id++) objects.push(`<object id="${id}" type="model"><components><component objectid="${id - 1}"/><component objectid="${id - 1}"/></components></object>`)
    expect(() => parse3MF(pack({ '3D/3dmodel.model': model(`<resources>${objects.join('')}</resources><build><item objectid="30"/></build>`) }))).toThrow(/more objects than ScanRuler can open/)
  })

  it('refuses archives whose expanded contents exceed the supported limits', async () => {
    const archive = pack({
      '3D/3dmodel.model': model(`<resources><object id="1" type="model">${TRIANGLE}</object></resources><build><item objectid="1"/></build>`),
      'Metadata/large.rels': 'x'.repeat(256),
      '3D/Textures/large.png': new Uint8Array(256),
    })
    const limits = { members: 10, entryBytes: 1024, totalBytes: 200 }
    expect(() => parse3MF(archive, undefined, undefined, limits)).toThrow(/supported archive size limits/)
    await expect(scanCompanions('large.3mf', new Uint8Array(archive), [], limits)).rejects.toThrow(/supported archive size limits/)
  })

  it('counts a stored member at its stored size, whatever size it declares', () => {
    const files = unzipSync(new Uint8Array(pack({
      '3D/3dmodel.model': model(`<resources><object id="1" type="model">${TRIANGLE}</object></resources><build><item objectid="1"/></build>`),
    })))
    // Stored, not deflated — then every member said to expand to nothing,
    // in its local header and in the central directory both.
    const stored = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: 0 }]])))
    const view = new DataView(stored.buffer)
    for (let i = 0; i + 4 <= stored.length; i++) {
      const signature = view.getUint32(i, true)
      if (signature === 0x04034b50) view.setUint32(i + 22, 0, true)
      else if (signature === 0x02014b50) view.setUint32(i + 24, 0, true)
    }
    const limits = { members: 10, entryBytes: 1024, totalBytes: 200 }
    expect(() => parse3MF(stored.buffer as ArrayBuffer, undefined, undefined, limits)).toThrow(/supported archive size limits/)
  })

  it('reads the model’s unit into millimetres', () => {
    const inch = parse3MF(pack({ '3D/3dmodel.model': model(`<resources><object id="1" type="model">${TRIANGLE}</object></resources><build><item objectid="1"/></build>`, 'inch') }))
    expect(Array.from(inch.positions)).toEqual([0, 0, 0, 25.4, 0, 0, 0, 25.4, 0].map((v) => Math.fround(v)))
    expect(() => parse3MF(pack({ '3D/3dmodel.model': model('<resources/><build/>', 'parsec') }))).toThrow(/unit "parsec"/)
  })

  it('puts components and build items in place, a mirror turned right way out', () => {
    const xml = model(
      `<resources><object id="1" type="model">${TRIANGLE}</object>` +
        '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object></resources>' +
        '<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 5"/><item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/></build>',
    )
    const mesh = parse3MF(pack({ '3D/3dmodel.model': xml }))
    expect(Array.from(mesh.positions.subarray(0, 9))).toEqual([10, 0, 5, 11, 0, 5, 10, 1, 5])
    expect(Array.from(mesh.positions.subarray(9, 15)).map((v) => v + 0)).toEqual([0, 0, 0, -1, 0, 0])
    // The mirrored copy's triangle wound back: 0 2 1 of its own vertices.
    expect(Array.from(mesh.indices!)).toEqual([0, 1, 2, 3, 5, 4])
  })

  it('follows components into other model files, and leaves a slicer’s modifiers out', () => {
    const root = model(
      '<resources><object id="9" type="model"><components>' +
        '<component p:path="/3D/Objects/object_1.model" objectid="1"/>' +
        '<component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 3"/>' +
        '</components></object><object id="10" type="support">' + TRIANGLE + '</object></resources>' +
        '<build><item objectid="9"/><item objectid="10"/></build>',
    )
    const objects = model(`<resources><object id="1" type="model">${TRIANGLE}</object><object id="2" type="model">${TRIANGLE}</object></resources><build/>`)
    const bambu = '<?xml version="1.0"?><config><object id="9"><part id="1" subtype="normal_part"/><part id="2" subtype="modifier_part"/></object></config>'
    const mesh = parse3MF(pack({ '3D/3dmodel.model': root, '3D/Objects/object_1.model': objects, 'Metadata/model_settings.config': bambu }))
    expect(mesh.indices!.length / 3).toBe(1)
    expect(Math.max(...Array.from(mesh.positions).filter((_, i) => i % 3 === 2))).toBe(0)
  })

  it('leaves out the triangles PrusaSlicer marks as a modifier volume', () => {
    const two = '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="7"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="3"/></triangles></mesh>'
    const prusa =
      '<?xml version="1.0"?><config><object id="1"><volume firstid="0" lastid="0"><metadata type="volume" key="volume_type" value="ModelPart"/></volume>' +
      '<volume firstid="1" lastid="1"><metadata type="volume" key="modifier" value="1"/><metadata type="volume" key="volume_type" value="ParameterModifier"/></volume></object></config>'
    const mesh = parse3MF(pack({ '3D/3dmodel.model': model(`<resources><object id="1" type="model">${two}</object></resources><build><item objectid="1"/></build>`), 'Metadata/Slic3r_PE_model.config': prusa }))
    expect(Array.from(mesh.indices!)).toEqual([0, 1, 2])
  })

  it('colours from base materials and colour groups, but not from one colour alone', () => {
    const colored = (props: string, tri: string) =>
      model(
        `<resources>${props}<object id="2" type="model" pid="1" pindex="0"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="1" y="1" z="0"/></vertices><triangles>${tri}</triangles></mesh></object></resources><build><item objectid="2"/></build>`,
      )
    const two = parse3MF(pack({ '3D/3dmodel.model': colored('<basematerials id="1"><base name="a" displaycolor="#FF000080"/><base name="b" displaycolor="#00FF00"/></basematerials>', '<triangle v1="0" v2="1" v3="2"/><triangle v1="1" v2="3" v3="2" p1="1"/>') }))
    expect(Array.from(two.colors!)).toEqual([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0])
    const one = parse3MF(pack({ '3D/3dmodel.model': colored('<m:colorgroup id="1"><m:color color="#808080"/></m:colorgroup>', '<triangle v1="0" v2="1" v3="2"/><triangle v1="1" v2="3" v3="2"/>') }))
    expect(one.colors).toBeUndefined()
  })

  it('bakes a packed texture onto the vertices, or names it missing', () => {
    const xml = model(
      '<resources><m:texture2d id="5" path="/3D/Textures/skin.png" contenttype="image/png"/>' +
        '<m:texture2dgroup id="6" texid="5"><m:tex2coord u="0.25" v="0.5"/><m:tex2coord u="0.75" v="0.5"/></m:texture2dgroup>' +
        '<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>' +
        '<triangles><triangle v1="0" v2="1" v3="2" pid="6" p1="0" p2="1" p3="1"/></triangles></mesh></object></resources><build><item objectid="1"/></build>',
    )
    // Two pixels: red on the left, blue on the right.
    const image = { name: '3D/Textures/skin.png', width: 2, height: 1, rgba: Uint8Array.of(255, 0, 0, 255, 0, 0, 255, 255) }
    const mesh = parse3MF(pack({ '3D/3dmodel.model': xml }), undefined, { materials: [], images: [image] })
    expect(Array.from(mesh.colors!.subarray(0, 3))).toEqual([255, 0, 0])
    expect(Array.from(mesh.colors!.subarray(3, 6))).toEqual([0, 0, 255])
    expect(mesh.texture).toEqual({ kind: 'applied', images: ['skin.png'] })
    const without = parse3MF(pack({ '3D/3dmodel.model': xml }))
    expect(without.texture).toEqual({ kind: 'missing', files: ['skin.png'] })
  })

  it('refuses what is not a 3MF or holds no part', () => {
    expect(() => parse3MF(new Uint8Array([1, 2, 3]).buffer)).toThrow(/could not be unzipped/)
    expect(() => parse3MF(pack({ '3D/3dmodel.model': model('<resources/><build/>') }))).toThrow(/no triangles/)
    expect(() => parse3MF(pack({ '3D/3dmodel.model': model('<resources/><build><item objectid="4"/></build>') }))).toThrow(/object 4/)
  })
})
