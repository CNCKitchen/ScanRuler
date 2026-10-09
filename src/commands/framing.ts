// SPDX-License-Identifier: AGPL-3.0-only
// The frames between this page and an agent's local server (bridge.ts).
// Every message is a JSON text frame; one that carries a file names where in
// it the bytes belong — `"binary": "result.file.bytes"` — and the very next
// frame is a binary frame holding them. A scan is hundreds of megabytes, and
// base64 in the JSON would make it a third larger and cost a copy at each
// end. The server's side of this is mcp/src/framing.js.

export type Message = Record<string, unknown>
type Frame = string | Uint8Array

/** `object` with the value at `keys` replaced, everything else shared. */
function replaced(object: Message, keys: string[], value: unknown): Message {
  const [key, ...rest] = keys
  return { ...object, [key]: rest.length ? replaced(object[key] as Message, rest, value) : value }
}

function getPath(object: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((at, key) => (at == null ? undefined : (at as Message)[key]), object)
}

function setPath(object: Message, path: string, value: unknown): void {
  const keys = path.split('.')
  let at = object
  for (const key of keys.slice(0, -1)) {
    if (typeof at[key] !== 'object' || at[key] === null) at[key] = {}
    at = at[key] as Message
  }
  at[keys[keys.length - 1]] = value
}

/** The frames a message goes as: the JSON, and the bytes at `binaryPath`
 *  after it when one is given — not copied; the JSON says only their size. */
export function encode(message: Message, binaryPath?: string): Frame[] {
  if (!binaryPath) return [JSON.stringify(message)]
  const bytes = getPath(message, binaryPath)
  if (!(bytes instanceof Uint8Array)) throw new Error(`No bytes at ${binaryPath}.`)
  const head = replaced(message, binaryPath.split('.'), { size: bytes.byteLength })
  return [JSON.stringify({ ...head, binary: binaryPath }), bytes]
}

/** Frames back into messages, the bytes put back in place. Throws on a
 *  broken peer: bytes nobody announced, or text where bytes were due. */
export function decoder(onMessage: (message: Message) => void): (frame: Frame) => void {
  let waiting: Message | null = null
  return (frame) => {
    if (typeof frame === 'string') {
      if (waiting) throw new Error(`Expected the bytes for ${String(waiting.binary)}, got text.`)
      const message = JSON.parse(frame) as unknown
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        throw new Error('A message must be a JSON object.')
      }
      if (typeof (message as Message).binary === 'string') {
        waiting = message as Message
        return
      }
      onMessage(message as Message)
      return
    }
    if (!waiting) throw new Error('Bytes arrived that no message announced.')
    const message = waiting
    waiting = null
    const path = message.binary as string
    delete message.binary
    setPath(message, path, frame)
    onMessage(message)
  }
}
