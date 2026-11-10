// SPDX-License-Identifier: AGPL-3.0-only
/** Filename history only: ordinary Save As does not expose a directory listing. */
export function projectRevisionName(base: string, previousName?: string): string {
  const previous = previousName && /^(.*)-(\d+)\.scanruler$/i.exec(previousName)
  const latest = previous && previous[1].toLowerCase() === base.toLowerCase() ? Number(previous[2]) : 0
  if (!Number.isSafeInteger(latest) || !Number.isSafeInteger(latest + 1)) {
    throw new Error('The next project revision number is too large.')
  }
  return `${base}-${String(latest + 1).padStart(3, '0')}.scanruler`
}

/** Keep an opened file's stem until the project title changes. A number typed
 *  into a project title is part of that title, not a revision to strip. */
export function revisionBase(projectFileName: string, previousName?: string, previousProjectFileName?: string): string {
  const titleChanged = previousProjectFileName !== undefined && projectFileName !== previousProjectFileName
  const name = !titleChanged && previousName ? previousName : projectFileName
  const stem = name.replace(/\.scanruler$/i, '')
  return name === previousName ? stem.replace(/-\d+$/, '') : stem
}
