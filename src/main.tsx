// SPDX-License-Identifier: AGPL-3.0-only
// The app's stylesheet first: a plugin's own stylesheet, loaded with the
// plugin, builds on it and has to come after it.
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installPlugins } from './plugins/registry'

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
