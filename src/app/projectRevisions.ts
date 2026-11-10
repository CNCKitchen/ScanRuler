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
}

export interface ProjectSaveTarget {
  name: string
  path: string
  write(bytes: Uint8Array): Promise<void>
}

type DirectoryPicker = (options: { id: string; mode: 'readwrite'; startIn?: RevisionDirectory }) => Promise<RevisionDirectory>

export type OutputKind = 'project' | 'export'
const directories: Record<OutputKind, RevisionDirectory | null> = { project: null, export: null }
const directoryKeys: Record<OutputKind, string> = { project: 'output-directory', export: 'export-directory' }

async function directoryStore(kind: OutputKind, mode: IDBTransactionMode, directory?: RevisionDirectory): Promise<RevisionDirectory | null> {
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
      const request = directory ? store.put(directory, directoryKeys[kind]) : store.get(directoryKeys[kind])
      transaction.oncomplete = () => resolve(directory ?? request.result ?? null)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('Output folder storage was aborted.'))
    })
  } finally { db.close() }
}

export function rememberOutputDirectory(directory: RevisionDirectory | null): void {
  directories.project = directory
}

export function supportsOutputFolders(): boolean {
  return typeof window !== 'undefined' && typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

export async function savedOutputDirectory(kind: OutputKind): Promise<RevisionDirectory | null> {
  return directories[kind] ?? await directoryStore(kind, 'readonly')
}

export async function chooseOutputDirectory(kind: OutputKind): Promise<RevisionDirectory> {
  const browser = window as Window & { showDirectoryPicker?: DirectoryPicker }
  if (!browser.showDirectoryPicker) throw new Error('Output folders require a browser with folder access, such as desktop Chrome or Edge.')
  // Open the picker before storage I/O can consume the click's user activation.
  const directory = await browser.showDirectoryPicker({
    id: kind === 'project' ? 'scanruler-project-revisions' : 'scanruler-exports',
    mode: 'readwrite', ...(directories[kind] ? { startIn: directories[kind] } : {}),
  })
  if (directory.queryPermission) await directoryStore(kind, 'readwrite', directory)
  directories[kind] = directory
  return directory
}

async function outputDirectory(kind: OutputKind): Promise<RevisionDirectory> {
  const saved = await savedOutputDirectory(kind)
  if (saved) {
    const permission = await saved.queryPermission?.({ mode: 'readwrite' })
    if (!saved.queryPermission || permission === 'granted' || await saved.requestPermission?.({ mode: 'readwrite' }) === 'granted') {
      directories[kind] = saved
      return saved
    }
    throw new Error(`Write permission for the saved ${kind} folder was not granted. Allow access or choose another folder in Settings, then try again.`)
  }
  return chooseOutputDirectory(kind)
}

export const projectOutputDirectory = () => outputDirectory('project')
export const exportOutputDirectory = () => outputDirectory('export')

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
  return chooseOutputDirectory('project')
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
  const browser = window as Window & {
    showSaveFilePicker?: (options: {
      id: string; suggestedName: string; startIn: RevisionDirectory
      types: { description: string; accept: Record<string, string[]> }[]
    }) => Promise<RevisionFile & { name: string }>
  }
  if (!browser.showSaveFilePicker) throw new Error('Save As requires a browser with file access, such as desktop Chrome or Edge.')
  const file = await browser.showSaveFilePicker({
    id: 'scanruler-project-revisions', suggestedName, startIn: directory,
    types: [{ description: 'ScanRuler project', accept: { 'application/zip': ['.scanruler'] } }],
  })
  return {
    name: file.name,
    path: file.name,
    async write(bytes) {
      await writeRevisionFile(file, bytes, 'application/zip')
    },
  }
}

/** Export under a new name without deliberately replacing an existing file. */
export async function writeMeshExport(directory: RevisionDirectory, name: string, bytes: Uint8Array, mimeType: string): Promise<string> {
  const names = new Set<string>()
  for await (const existing of directory.keys()) names.add(existing.toLowerCase())
  const dot = name.lastIndexOf('.')
  if (dot <= 0) throw new Error('The export filename must have an extension.')
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
