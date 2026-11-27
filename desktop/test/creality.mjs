// SPDX-License-Identifier: AGPL-3.0-only
// The watcher reports a Mesh.ply once, after it stops growing, and ignores the rest of a project.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { isMesh, meshOfProject, watchMeshes } from '../creality.js'
import { utimesSync } from 'node:fs'

assert(isMesh('C:\\Scan\\P\\data\\result\\Mesh.ply'))
assert(isMesh('/scan/p/data/result/mesh.ply'))
assert(!isMesh('C:\\Scan\\P\\data\\result\\Fused.ply'))
assert(!isMesh('C:\\Scan\\P\\Mesh.ply'))

// project.obp: the final mesh, else the newest session's fused scan, else a clear error
const proj = mkdtempSync(join(tmpdir(), 'obp-'))
const put = (...p) => { mkdirSync(join(proj, ...p.slice(0, -1)), { recursive: true }); writeFileSync(join(proj, ...p), 'x') }
writeFileSync(join(proj, 'project.obp'), 'name: project\ndata_dir: dData\ncombinations:\n  []\nsessions:\n  - sOld\n  - sNew\nplatform: windows\n')
assert.throws(() => meshOfProject(join(proj, 'project.obp')), /ainda não tem malha/)
put('sOld', 'result', 'Fused.ply'); put('sNew', 'result', 'Fused.ply')
utimesSync(join(proj, 'sOld', 'result', 'Fused.ply'), new Date(2020, 0, 1), new Date(2020, 0, 1))
assert.equal(meshOfProject(join(proj, 'project.obp')), join(proj, 'sNew', 'result', 'Fused.ply'))
put('dData', 'result', 'Mesh.ply')
assert.equal(meshOfProject(join(proj, 'project.obp')), join(proj, 'dData', 'result', 'Mesh.ply'))
rmSync(proj, { recursive: true, force: true })

const dir = mkdtempSync(join(tmpdir(), 'creality-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const got = []
const stop = watchMeshes(dir, (path, project) => got.push({ path, project }), { settleMs: 150 })
try {
  const result = join(dir, 'Peca_1', '20260101', 'result')
  mkdirSync(result, { recursive: true })
  writeFileSync(join(result, 'Fused.ply'), 'x') // not the final mesh
  writeFileSync(join(result, 'Mesh.ply'), 'a')
  await sleep(100)
  appendFileSync(join(result, 'Mesh.ply'), 'b') // still being written
  await sleep(100)
  appendFileSync(join(result, 'Mesh.ply'), 'c')
  await sleep(800)
  assert.equal(got.length, 1, `one report after it settled, got ${got.length}`)
  assert.equal(got[0].project, 'Peca_1')
  assert(got[0].path.endsWith('Mesh.ply'))
  appendFileSync(join(result, 'Mesh.ply'), 'd') // a re-mesh later reports again
  await sleep(800)
  assert.equal(got.length, 2)
  console.log('creality watcher ok')
} finally {
  stop()
  rmSync(dir, { recursive: true, force: true })
}
