// SPDX-License-Identifier: AGPL-3.0-only
interface SaveFileHandle {
  name: string
  createWritable(): Promise<{
    write(blob: Blob): Promise<void>
    close(): Promise<void>
    abort(): Promise<void>
  }>
}

export interface SaveTarget {
  name: string
  write(blob: Blob): Promise<void>
}

export interface SavePickerOptions {
  id: string
  suggestedName: string
  types: { description: string; accept: Record<string, string[]> }[]
}

/** Call from the click, before packing, lazy imports or worker calls. Leaving
 *  startIn unset lets the browser remember navigation independently per ID. */
export async function chooseSaveTarget(kind: 'project' | 'export', name: string): Promise<SaveTarget | null> {
  const browser = typeof window === 'undefined' ? undefined : window as Window & {
    showSaveFilePicker?: (options: SavePickerOptions) => Promise<SaveFileHandle>
  }
  if (!browser?.showSaveFilePicker) return null
  const extension = name.slice(name.lastIndexOf('.'))
  const file = await browser.showSaveFilePicker({
    id: kind === 'project' ? 'scanruler-projects' : 'scanruler-exports',
    suggestedName: name,
    types: [{
      description: kind === 'project' ? 'ScanRuler project' : `${extension.slice(1).toUpperCase()} file`,
      accept: { [kind === 'project' ? 'application/zip' : 'application/octet-stream']: [extension] },
    }],
  })
  return {
    name: file.name,
    async write(blob) {
      const stream = await file.createWritable()
      try {
        await stream.write(blob)
        await stream.close()
      } catch (error) {
        try { await stream.abort() }
        catch (abortError) {
          throw new Error(`Writing output failed: ${String(error)}. Aborting the write also failed: ${String(abortError)}`)
        }
        throw error
      }
    },
  }
}
