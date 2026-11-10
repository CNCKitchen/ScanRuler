// SPDX-License-Identifier: AGPL-3.0-only
interface RevisionFile {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>
    close(): Promise<void>
    abort(): Promise<void>
  }>
}

export interface RevisionDirectory {
  name: string
  keys(): AsyncIterableIterator<string>
  getFileHandle(name: string, options?: { create: boolean }): Promise<RevisionFile>
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>
  chooseSave?(name: string): Promise<ProjectSaveTarget>
}

export interface ProjectSaveTarget {
  name: string
  path: string
  write(bytes: Uint8Array): Promise<void>
}

type DirectoryPicker = (options: { id: string; mode: 'readwrite' }) => Promise<RevisionDirectory>

let outputDirectory: RevisionDirectory | null = null
const savedDirectoryKey = 'output-directory'

async function directoryStore(mode: IDBTransactionMode, directory?: RevisionDirectory): Promise<RevisionDirectory | null> {
  if (typeof indexedDB === 'undefined') return null
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('scanruler-output', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('settings')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('settings', mode)
      const store = transaction.objectStore('settings')
      const request = directory ? store.put(directory, savedDirectoryKey) : store.get(savedDirectoryKey)
      transaction.oncomplete = () => resolve(directory ?? request.result ?? null)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('Output folder storage was aborted.'))
    })
  } finally { db.close() }
}

async function localDirectory(): Promise<RevisionDirectory> {
  const request = async (name?: string, data?: Blob): Promise<Response> => {
    const response = await fetch(`/__scanruler/output${name ? `?name=${encodeURIComponent(name)}` : ''}`, {
      method: data ? 'POST' : 'GET',
      headers: { 'X-ScanRuler-Output': '1' },
      body: data,
    })
    if (!response.ok) throw new Error(`Local output folder: ${await response.text()}`)
    return response
  }
  const info: { name: string; names: string[] } = await (await request()).json()
  return {
    name: info.name,
    async chooseSave(name) {
      const response = await fetch(`/__scanruler/output?choose=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'X-ScanRuler-Output': '1' },
      })
      if (response.status === 204) throw new DOMException('Save cancelled.', 'AbortError')
      if (!response.ok) throw new Error(await response.text())
      const selected: { token: string; name: string; directory: string } = await response.json()
      return {
        name: selected.name,
        path: `${selected.directory}\\${selected.name}`,
        async write(bytes) {
          const result = await fetch(`/__scanruler/output?selection=${encodeURIComponent(selected.token)}`, {
            method: 'POST', headers: { 'X-ScanRuler-Output': '1' }, body: new Blob([bytes as BlobPart]),
          })
          if (!result.ok) throw new Error(await result.text())
          rememberOutputDirectory(await localDirectory())
        },
      }
    },
    async *keys() {
      const current: { names: string[] } = await (await request()).json()
      yield* current.names
    },
    async getFileHandle(name) {
      return {
        async createWritable() {
          let data: Blob | null = null
          return {
            async write(blob) { data = blob },
            async close() {
              if (!data) throw new Error('No output data was supplied.')
              await request(name, data)
            },
            async abort() { data = null },
          }
        },
      }
    },
  }
}

export function rememberOutputDirectory(directory: RevisionDirectory | null): void {
  outputDirectory = directory
}

export function usesLocalOutput(): boolean {
  return (import.meta.env.DEV || import.meta.env.VITE_LOCAL_REVIEW === '1') && ((/Windows NT/.test(navigator.userAgent) &&
    /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)) || /\bElectron\//.test(navigator.userAgent))
}

/** Export selections have their own remembered folder on the local server. */
export async function saveLocalExport(name: string, blob: Blob): Promise<string> {
  const response = await fetch(`/__scanruler/output?choose=${encodeURIComponent(name)}&kind=export`, {
    method: 'POST', headers: { 'X-ScanRuler-Output': '1' },
  })
  if (response.status === 204) throw new DOMException('Export cancelled.', 'AbortError')
  if (!response.ok) throw new Error(await response.text())
  const selected: { token: string; name: string; directory: string } = await response.json()
  const written = await fetch(`/__scanruler/output?selection=${encodeURIComponent(selected.token)}`, {
    method: 'POST', headers: { 'X-ScanRuler-Output': '1' }, body: blob,
  })
  if (!written.ok) throw new Error(await written.text())
  return `${selected.directory}\\${selected.name}`
}

export async function projectOutputDirectory(): Promise<RevisionDirectory> {
  if (outputDirectory) return outputDirectory
  if (usesLocalOutput()) {
    outputDirectory = await localDirectory()
    return outputDirectory
  }
  const saved = await directoryStore('readonly')
  if (saved) {
    const permission = await saved.queryPermission?.({ mode: 'readwrite' })
    if (permission === 'granted' || await saved.requestPermission?.({ mode: 'readwrite' }) === 'granted') {
      outputDirectory = saved
      return saved
    }
    throw new Error('Write permission for the saved output folder was not granted. Allow access in the browser, then try Save again.')
  }
  outputDirectory = await chooseRevisionDirectory()
  if (outputDirectory.queryPermission) await directoryStore('readwrite', outputDirectory)
  return outputDirectory
}

export function projectRevisionName(base: string, names: string[], openedName?: string): string {
  const opened = openedName && /^(.*)-(\d+)\.scanruler$/i.exec(openedName)
  let latest = opened && opened[1].toLowerCase() === base.toLowerCase() ? Number(opened[2]) : 0
  for (const name of names) {
    const match = /^(.*)-(\d+)\.scanruler$/i.exec(name)
    if (match && match[1].toLowerCase() === base.toLowerCase()) {
      const revision = Number(match[2])
      if (!Number.isSafeInteger(revision)) throw new Error('A project revision number is too large to increment safely.')
      latest = Math.max(latest, revision)
    }
  }
  if (!Number.isSafeInteger(latest + 1)) throw new Error('The next project revision number is too large.')
  return `${base}-${String(latest + 1).padStart(3, '0')}.scanruler`
}

export function revisionBase(projectFileName: string, openedName?: string, previousProjectFileName?: string): string {
  const titleChanged = previousProjectFileName !== undefined && projectFileName !== previousProjectFileName
  const name = !titleChanged && openedName ? openedName : projectFileName
  const stem = name.replace(/\.scanruler$/i, '')
  return name === openedName ? stem.replace(/-\d+$/, '') : stem
}

export async function chooseRevisionDirectory(): Promise<RevisionDirectory> {
  const browser = window as Window & { showDirectoryPicker?: DirectoryPicker }
  if (!browser.showDirectoryPicker) {
    throw new Error('Saving numbered revisions directly to a folder requires Chrome or Edge. Open this local app there and select your output folder.')
  }
  return browser.showDirectoryPicker({ id: 'scanruler-project-revisions', mode: 'readwrite' })
}

export async function writeProjectRevision(
  directory: RevisionDirectory,
  base: string,
  bytes: Uint8Array,
  openedName?: string,
): Promise<string> {
  const names: string[] = []
  for await (const name of directory.keys()) names.push(name)
  const name = projectRevisionName(base, names, openedName)
  await writeOutputFile(directory, name, bytes, 'application/zip')
  return name
}

export async function chooseProjectSave(directory: RevisionDirectory, base: string, openedName?: string): Promise<ProjectSaveTarget> {
  const names: string[] = []
  for await (const name of directory.keys()) names.push(name)
  const suggestedName = projectRevisionName(base, names, openedName)
  if (directory.chooseSave) return directory.chooseSave(suggestedName)
  const browser = window as Window & {
    showSaveFilePicker?: (options: {
      id: string; suggestedName: string; startIn: RevisionDirectory
      types: { description: string; accept: Record<string, string[]> }[]
    }) => Promise<RevisionFile & { name: string; getParent?: () => Promise<RevisionDirectory | null> }>
  }
  if (!browser.showSaveFilePicker) throw new Error('Save As requires Chrome or Edge, or the configured Windows local app.')
  const file = await browser.showSaveFilePicker({
    id: 'scanruler-project-revisions', suggestedName, startIn: directory,
    types: [{ description: 'ScanRuler project', accept: { 'application/zip': ['.scanruler'] } }],
  })
  return {
    name: file.name,
    path: file.name,
    async write(bytes) {
      await writeRevisionFile(file, bytes, 'application/zip')
      const parent = await file.getParent?.()
      if (parent) {
        rememberOutputDirectory(parent)
        await directoryStore('readwrite', parent)
      }
    },
  }
}

/** Export under a new name, never replacing an existing mesh export. */
export async function writeMeshExport(directory: RevisionDirectory, name: string, bytes: Uint8Array, mimeType: string): Promise<string> {
  const names = new Set<string>()
  for await (const existing of directory.keys()) names.add(existing.toLowerCase())
  const dot = name.lastIndexOf('.')
  if (dot <= 0) throw new Error('The mesh export filename must have an extension.')
  const stem = name.slice(0, dot), extension = name.slice(dot)
  let saved = name, revision = 2
  while (names.has(saved.toLowerCase())) saved = `${stem}-${revision++}${extension}`
  await writeOutputFile(directory, saved, bytes, mimeType)
  return saved
}

async function writeOutputFile(directory: RevisionDirectory, name: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true })
  await writeRevisionFile(file, bytes, mimeType)
}

async function writeRevisionFile(file: RevisionFile, bytes: Uint8Array, mimeType: string): Promise<void> {
  const stream = await file.createWritable()
  try {
    await stream.write(new Blob([bytes as BlobPart], { type: mimeType }))
    await stream.close()
  } catch (error) {
    try { await stream.abort() }
    catch (abortError) {
      throw new Error(`Writing output failed: ${String(error)}. Aborting the write also failed: ${String(abortError)}`)
    }
    throw error
  }
}
