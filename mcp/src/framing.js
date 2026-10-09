// SPDX-License-Identifier: AGPL-3.0-only
// The messages between this server and the ScanRuler page, over one
// WebSocket. Every message is a JSON text frame. One that carries a file
// names where in it the bytes belong — `"binary": "input.bytes"` — and the
// very next frame on the socket is a binary frame holding them. Scans are
// hundreds of megabytes; base64 inside the JSON would make them a third
// larger again and cost a copy at each end. The page's side of this is
// src/commands/bridge.ts in the app.

/** Split a message into the frames that carry it: the JSON, and the bytes
 *  found at `binaryPath`, if one is given — taken out of the JSON and sent
 *  after it. */
export function encode(message, binaryPath) {
  if (!binaryPath) return [JSON.stringify(message)]
  const bytes = getPath(message, binaryPath)
  if (!(bytes instanceof Uint8Array)) throw new Error(`No bytes at ${binaryPath}.`)
  // The objects along the path are copied, the bytes are not: the JSON says
  // only how many there are.
  const head = replaced(message, binaryPath.split('.'), { size: bytes.byteLength })
  return [JSON.stringify({ ...head, binary: binaryPath }), bytes]
}

/** `object` with the value at `keys` replaced, the rest shared. */
function replaced(object, keys, value) {
  const [key, ...rest] = keys
  return { ...object, [key]: rest.length ? replaced(object[key], rest, value) : value }
}

/**
 * Put frames back together into messages. Feed it every frame as it comes,
 * text as a string and binary as a Uint8Array; it calls `onMessage` with each
 * whole message, its bytes back in place. A binary frame nobody announced,
 * or text where bytes were announced, is a broken peer — it throws.
 */
export function decoder(onMessage) {
  let waiting = null
  return (frame) => {
    if (typeof frame === 'string') {
      if (waiting) throw new Error(`Expected the bytes for ${waiting.binary}, got text.`)
      const message = JSON.parse(frame)
      if (typeof message !== 'object' || message === null || Array.isArray(message)) throw new Error('A message must be a JSON object.')
      if (typeof message.binary === 'string') {
        waiting = message
        return
      }
      onMessage(message)
      return
    }
    if (!waiting) throw new Error('Bytes arrived that no message announced.')
    const message = waiting
    waiting = null
    const path = message.binary
    delete message.binary
    setPath(message, path, frame)
    onMessage(message)
  }
}

function getPath(object, path) {
  return path.split('.').reduce((at, key) => (at == null ? undefined : at[key]), object)
}

function setPath(object, path, value) {
  const keys = path.split('.')
  let at = object
  for (const key of keys.slice(0, -1)) {
    if (typeof at[key] !== 'object' || at[key] === null) at[key] = {}
    at = at[key]
  }
  at[keys.at(-1)] = value
}
