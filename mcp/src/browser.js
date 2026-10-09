// SPDX-License-Identifier: AGPL-3.0-only
// Opening the pairing link in the user's default browser, so that
// scanruler_open can bring up a ScanRuler tab that is already paired with
// this server — nothing for the user to copy or click but the browser's own
// question whether the site may reach this computer.

import { spawn } from 'node:child_process'

/** A link safe to hand to the shell that opens it: http(s), and none of the
 *  characters cmd.exe reads inside quotes (`%`, `"`, `^`) or spaces. */
const SAFE = /^https?:\/\/[\w.:/#=?&~-]+$/

/** The program and its arguments that open `url` in the default browser. */
export function openCommand(url, platform = process.platform) {
  // `start` is cmd's; its first quoted argument is a window title, hence "".
  if (platform === 'win32') return { command: 'cmd', args: ['/d', '/c', 'start', '""', `"${url}"`], verbatim: true }
  if (platform === 'darwin') return { command: 'open', args: [url], verbatim: false }
  return { command: 'xdg-open', args: [url], verbatim: false }
}

/** Open `url` in the default browser. Resolves true once the opener has
 *  started — whether a browser came up is for the caller to find out (the
 *  page connecting) — and false when the link is not one to open or the
 *  opener could not be started. */
export function openInBrowser(url, platform = process.platform) {
  if (!SAFE.test(url)) return Promise.resolve(false)
  const { command, args, verbatim } = openCommand(url, platform)
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: verbatim })
    } catch {
      resolve(false)
      return
    }
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}
