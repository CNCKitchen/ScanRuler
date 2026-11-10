// SPDX-License-Identifier: AGPL-3.0-only
// The app's stylesheet first: a plugin's own stylesheet, loaded with the
// plugin, builds on it and has to come after it.
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installPlugins } from './plugins/registry'

// Escape while a dropdown's list is open closes the list and nothing else.
// Where the browser draws the list in the page (`appearance: base-select`,
// see styles.css) the key goes through the page first, and the dialogs' and
// draft boxes' own Escape, caught on its way down, would close the box
// under the list and throw its draft away. Registered before anything else,
// so it is the first to see the key; the browser still closes the list.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape') return
    let open = false
    try {
      open = document.querySelector('select:open') !== null
    } catch {
      // A browser that does not know :open draws the list itself.
    }
    if (open) e.stopImmediatePropagation()
  },
  true,
)

// Before anything renders: what the plugins register is part of the app
// from its first frame.
installPlugins()

// The browser's own right-click menu (Back, Reload, Save as…) has nothing to
// do in an app. It stays where it is of use: in a text field, for cut, copy
// and paste, and over selected text, for copy.
document.addEventListener('contextmenu', (e) => {
  const t = e.target as Element | null
  if (t?.closest?.('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]), textarea, [contenteditable=""], [contenteditable="true"]')) return
  if (!(window.getSelection()?.isCollapsed ?? true)) return
  e.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
