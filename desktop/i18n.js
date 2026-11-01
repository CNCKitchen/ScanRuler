// SPDX-License-Identifier: AGPL-3.0-only
// Runtime translation of the ScanRuler page: the English text the app draws is
// swapped for the dictionary's text, node by node, and kept in step as React
// redraws. The ScanRuler source is not touched. Text drawn on a canvas (3D
// labels) and text built from numbers at run time are not covered.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// The shell's own text, in English; a dictionary's "_menu" and "_hw" override it.
const MENU = { file: 'File', open: 'Open scan…', quit: 'Quit', view: 'View', help: 'Help', hardware: 'Hardware…', language: 'Language', watch: 'Watch Creality Scan folder…', unwatch: 'Stop watching Creality Scan', fresh: 'New Mesh.ply from project', openIt: 'Open in ScanRuler', ignore: 'Ignore' }
const HW = { title: 'Hardware', gpu: 'GPU', backendChosen: 'ANGLE backend chosen', backendRunning: 'ANGLE backend running', renderer: 'WebGL2 / renderer', webgpu: 'WebGPU', cpu: 'CPU (threads)', threads: 'logical threads', isolation: 'Cross-origin isolation (WASM threads)', npu: 'NPU / WebNN', versions: 'Electron / Chromium', backend: 'Graphics backend:', restart: 'Restart to apply', changed: 'Backend changed: restart to apply.', yes: 'yes', no: 'no', available: 'available', unavailable: 'unavailable', default: 'default', experimental: 'experimental' }

const files = new Map() // lang -> parsed i18n/<lang>.json
const read = (lang) => {
  if (!files.has(lang)) {
    try {
      files.set(lang, JSON.parse(readFileSync(join(here, 'i18n', `${lang}.json`), 'utf8')))
    } catch {
      files.set(lang, null)
    }
  }
  return files.get(lang)
}

/** Every language with a file in i18n/, plus English: id -> its own name. */
export const LANGUAGES = Object.fromEntries([
  ['en', 'English'],
  ...readdirSync(join(here, 'i18n'))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_')) // _english-keys.json lists the source strings for translators
    .map((f) => f.slice(0, -5))
    .map((lang) => [lang, read(lang)?._name ?? lang]),
])

/** The language to start in: the OS's, where a file for it exists, else English. */
export function defaultLanguage(locale) {
  const ids = Object.keys(LANGUAGES)
  return ids.find((id) => id.toLowerCase() === locale.toLowerCase()) ?? ids.find((id) => id.split('-')[0] === locale.split('-')[0]) ?? 'en'
}

/** The page's words of a language, or null for English (the page as it is). */
export function loadDict(lang) {
  const d = read(lang)
  return d ? Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('_'))) : null
}

export const menuOf = (lang) => ({ ...MENU, ...read(lang)?._menu })
export const hwOf = (lang) => ({ ...HW, ...read(lang)?._hw })

/** A script that installs the translator in the page, or switches its dictionary. */
export function injectScript(dict) {
  return `(${engine.toString()})(${JSON.stringify(dict)})`
}

function engine(dict) {
  if (window.__srI18n) return window.__srI18n.set(dict)
  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt']
  const tracked = new Set() // WeakRef of {node, attr?, orig, mine}
  const byTarget = new WeakMap() // node|element -> {text?: rec, attrs: {name: rec}}
  let words = null

  const skip = (el) => !el || /^(SCRIPT|STYLE|TEXTAREA|CODE|PRE)$/.test(el.tagName) || el.isContentEditable || el.closest?.('[data-no-i18n]')
  const split = (s) => [s.match(/^\s*/)[0], s.trim(), s.match(/\s*$/)[0]]

  function setText(node) {
    if (skip(node.parentElement)) return
    let rec = byTarget.get(node)?.text
    if (rec && node.nodeValue === rec.mine) return // our own write
    const [lead, core, tail] = split(node.nodeValue)
    if (!core) return
    const to = words?.[core]
    if (!to) { if (rec) rec.mine = null; return }
    if (!rec) {
      rec = { ref: new WeakRef(node), kind: 'text' }
      byTarget.set(node, { ...(byTarget.get(node) ?? { attrs: {} }), text: rec })
      tracked.add(rec)
    }
    rec.orig = node.nodeValue
    rec.mine = lead + to + tail
    node.nodeValue = rec.mine
  }

  function setAttr(el, name) {
    const cur = el.getAttribute(name)
    if (cur == null) return
    const entry = byTarget.get(el) ?? { attrs: {} }
    byTarget.set(el, entry)
    let rec = entry.attrs[name]
    if (rec && cur === rec.mine) return
    const to = words?.[cur.trim()]
    if (!to) return
    if (!rec) { rec = { ref: new WeakRef(el), kind: 'attr', name }; entry.attrs[name] = rec; tracked.add(rec) }
    rec.orig = cur
    rec.mine = to
    el.setAttribute(name, to)
  }

  function walk(root) {
    if (!words) return
    if (root.nodeType === Node.TEXT_NODE) return setText(root)
    if (root.nodeType !== Node.ELEMENT_NODE) return
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n; (n = w.nextNode()); ) setText(n)
    const els = root.matches?.('[title],[aria-label],[placeholder],[alt]') ? [root] : []
    for (const el of [...els, ...root.querySelectorAll('[title],[aria-label],[placeholder],[alt]')]) for (const a of ATTRS) setAttr(el, a)
  }

  function restore() {
    for (const rec of tracked) {
      const t = rec.ref.deref()
      if (!t) { tracked.delete(rec); continue }
      if (rec.kind === 'text' && t.nodeValue === rec.mine) t.nodeValue = rec.orig
      if (rec.kind === 'attr' && t.getAttribute(rec.name) === rec.mine) t.setAttribute(rec.name, rec.orig)
      rec.mine = null
    }
  }

  const observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(walk)
      else if (m.type === 'characterData') setText(m.target)
      else if (m.type === 'attributes') setAttr(m.target, m.attributeName)
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })

  window.__srI18n = {
    set(next) {
      restore()
      words = next
      if (words) walk(document.body)
    },
  }
  window.__srI18n.set(dict)
}
