// SPDX-License-Identifier: AGPL-3.0-only
// Watches a folder of Creality Scan projects for a finished <project>/<data>/result/Mesh.ply
// (the scan's final mesh) and says when one appears or changes, once its file stops growing.
import { watch, statSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const MESH = /[\\/]result[\\/]Mesh\.ply$/i
const SETTLE_MS = 1500

export const isMesh = (path) => MESH.test(path)

/** Calls onMesh(path, project) for each Mesh.ply under `dir` once its size is steady; returns stop(). */
export function watchMeshes(dir, onMesh, { settleMs = SETTLE_MS } = {}) {
  const waiting = new Map() // path -> timer
  const check = (path, last) => {
    let size
    try {
      size = statSync(path).size
    } catch {
      return waiting.delete(path) // gone again before it settled
    }
    if (size > 0 && size === last) {
      waiting.delete(path)
      return onMesh(path, relative(dir, path).split(sep)[0])
    }
    waiting.set(path, setTimeout(() => check(path, size), settleMs))
  }
  const watcher = watch(dir, { recursive: true }, (_event, name) => {
    if (!name) return
    const path = `${dir}${sep}${name}`
    if (!isMesh(path)) return
    clearTimeout(waiting.get(path))
    waiting.set(path, setTimeout(() => check(path, -1), settleMs))
  })
  return () => {
    watcher.close()
    for (const t of waiting.values()) clearTimeout(t)
    waiting.clear()
  }
}

/** The scan a project.obp stands for: its final Mesh.ply, else the newest session's Fused.ply. */
export function meshOfProject(obp) {
  const dir = dirname(obp)
  const text = readFileSync(obp, 'utf8')
  const data = /^data_dir:\s*(\S+)/m.exec(text)?.[1]
  const final = data && join(dir, data, 'result', 'Mesh.ply')
  if (final && existsSync(final)) return final
  const sessions = [...text.matchAll(/^\s*-\s*(\S+)\s*$/gm)]
    .map((m) => join(dir, m[1], 'result', 'Fused.ply'))
    .filter((f) => existsSync(f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (sessions.length) return sessions[0]
  throw new Error('Este projeto do Creality Scan ainda não tem malha (Mesh.ply) nem scan fundido (Fused.ply).')
}
