// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { get } from 'node:http'
import { CLOSE, originAllowed, PageLink } from '../src/link.js'
import { PeerLink } from '../src/relay.js'
import { HELLO_PATH, httpServer } from '../src/serve.js'
import { fakePage } from './fakePage.js'

const TOKEN = 'a-test-token-of-some-length'
let link
let http
let port

before(async () => {
  link = new PageLink({ token: TOKEN, origins: ['https://scanruler.example'] })
  http = httpServer({ allowOrigin: (o) => originAllowed(o, ['https://scanruler.example']), version: '9.9.9' })
  link.attach(http)
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  port = http.address().port
})
after(() => {
  link.close()
  http.close()
})

test('pages are let in from the hosted app, loopback, and origins named', () => {
  assert.ok(originAllowed('https://scanruler.com'))
  assert.ok(originAllowed('http://localhost:5187'))
  assert.ok(originAllowed('http://127.0.0.1:7317'))
  assert.ok(originAllowed('https://scanruler.example', ['https://scanruler.example']))
  assert.ok(originAllowed(undefined), 'no Origin: not a browser page; the token decides')
  assert.equal(originAllowed('https://evil.example'), false)
  assert.equal(originAllowed('http://scanruler.com'), false, 'not the hosted app over plain http')
  assert.equal(originAllowed('null'), false)
})

/** GET a path with an Origin header; resolves with the status, headers and body. */
const fetchWithOrigin = (path, origin) =>
  new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path, headers: origin ? { origin } : {} }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    }).on('error', reject)
  })

test('the hello a page fetches first answers an allowed origin, and only that one, with CORS', async () => {
  const ok = await fetchWithOrigin(HELLO_PATH, 'https://scanruler.com')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['access-control-allow-origin'], 'https://scanruler.com')
  assert.equal(ok.headers['access-control-allow-private-network'], 'true')
  assert.deepEqual(JSON.parse(ok.body), { server: 'scanruler-mcp', version: '9.9.9' })
  const other = await fetchWithOrigin(HELLO_PATH, 'https://evil.example')
  assert.equal(other.headers['access-control-allow-origin'], undefined)
  const root = await fetchWithOrigin('/', 'https://scanruler.com')
  assert.match(root.body, /waiting for the ScanRuler page/)
})

test('a page from another origin is turned away before it can say anything', async () => {
  const r = await fakePage(port, { token: TOKEN, origin: 'https://evil.example' })
  assert.equal(r.code, 403)
  assert.equal(link.connected, false)
})

test('a page with the wrong token is turned away, and told why', async () => {
  const r = await fakePage(port, { token: 'wrong' })
  assert.match(r.refused, /pairing token/)
  assert.equal(r.code, CLOSE.badToken)
  assert.equal(link.connected, false)
})

test('one page at a time; runs go to it, bytes both ways, errors as they came', async () => {
  const one = await fakePage(port, {
    token: TOKEN,
    answer: (name, input) => {
      if (name === 'scan.open') return { scan: { fileName: input.name, size: input.bytes.byteLength } }
      if (name === 'export.step') return { file: { name: 'x.step', mimeType: 'model/step', bytes: new Uint8Array([1, 2, 3]) } }
      throw { code: 'no_scan', message: 'No scan is open.' }
    },
  })
  assert.ok(one.welcome)
  assert.equal(link.connected, true)
  assert.equal(link.page.version, '0.0.0-test')
  assert.equal(link.page.token, undefined, 'the token is not kept with what the page said')

  const two = await fakePage(port, { token: TOKEN })
  assert.equal(two.code, CLOSE.taken)
  assert.equal(link.connected, true, 'the first page stays')

  const opened = await link.run('scan.open', { name: 'a.stl', bytes: new Uint8Array(1000) }, 'bytes')
  assert.deepEqual(opened, { scan: { fileName: 'a.stl', size: 1000 } })
  const exported = await link.run('export.step', {})
  assert.deepEqual([...exported.file.bytes], [1, 2, 3])
  await assert.rejects(link.run('element.fit', {}), { code: 'no_scan', message: 'No scan is open.' })

  const gone = new Promise((resolve) => link.once('disconnected', resolve))
  one.page.close()
  await gone
  assert.equal(link.connected, false)
  await assert.rejects(link.run('session.state', {}), { code: 'unavailable' })
})

test('another copy with the token is let in beside the page and relays through it, told as the page comes and goes', async () => {
  const wrong = new PeerLink({ port, token: 'wrong' })
  assert.match((await wrong.connect()).refused, /pairing token/)

  const peer = new PeerLink({ port, token: TOKEN, version: '0.0.0-peer' })
  assert.deepEqual(await peer.connect(), { ok: true })
  assert.equal(peer.connected, false, 'no page yet')
  await assert.rejects(peer.run('session.state', {}), { code: 'unavailable' })

  const arrived = new Promise((resolve) => peer.once('connected', resolve))
  const page = await fakePage(port, {
    token: TOKEN,
    answer: (name, input, progress) => {
      if (name === 'scan.open') {
        progress('Reading the scan')
        return { scan: { fileName: input.name, size: input.bytes.byteLength } }
      }
      if (name === 'export.step') return { file: { name: 'x.step', mimeType: 'model/step', bytes: new Uint8Array([4, 5, 6]) } }
      throw { code: 'no_scan', message: 'No scan is open.' }
    },
  })
  assert.equal((await arrived).version, '0.0.0-test')
  assert.equal(peer.connected, true)

  const lines = []
  const opened = await peer.run('scan.open', { name: 'b.stl', bytes: new Uint8Array(2000) }, 'bytes', (line) => lines.push(line))
  assert.deepEqual(opened, { scan: { fileName: 'b.stl', size: 2000 } })
  assert.deepEqual(lines, ['Reading the scan'])
  assert.deepEqual([...(await peer.run('export.step', {})).file.bytes], [4, 5, 6])
  await assert.rejects(peer.run('element.fit', {}), { code: 'no_scan', message: 'No scan is open.' })
  assert.equal(page.page.runs.length, 3, 'the page ran what the peer sent')
  assert.equal(link.connected, true, 'and the page is still the holder’s')

  const left = new Promise((resolve) => peer.once('disconnected', resolve))
  page.page.close()
  await left
  assert.equal(peer.connected, false)
  const closed = new Promise((resolve) => peer.once('closed', resolve))
  peer.close()
  await closed
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(link.peers.size, 0)
})

test('waiting for a page ends when one connects, or when the time is up', async () => {
  assert.equal(await link.waitForPage(30), false)
  const waiting = link.waitForPage(5000)
  const page = await fakePage(port, { token: TOKEN })
  assert.equal(await waiting, true)
  page.page.close()
  await new Promise((resolve) => link.once('disconnected', resolve))
})
