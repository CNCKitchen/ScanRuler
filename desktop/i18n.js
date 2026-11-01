// SPDX-License-Identifier: AGPL-3.0-only
// Runtime translation of the ScanRuler page: the English text the app draws is
// swapped for the dictionary's text, node by node, and kept in step as React
// redraws. The ScanRuler source is not touched. Text drawn on a canvas (3D
// labels) and text built from numbers at run time are not covered.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const LANGUAGES = { 'pt-BR': 'Português (Brasil)', en: 'English' }

/** The dictionary of a language, or null for English (the page as it is). */
export function loadDict(lang) {
  if (lang === 'en') return null
  try {
    return JSON.parse(readFileSync(join(here, 'i18n', `${lang}.json`), 'utf8'))
  } catch {
    return null
  }
}

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
