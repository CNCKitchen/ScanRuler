// SPDX-License-Identifier: AGPL-3.0-only
// Sets the dark theme before the first paint, from the same key the settings
// store keeps it under, so a dark chassis never flashes light on load.
try {
  var t = localStorage.getItem('scanruler.uitheme')
  if (t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches))
    document.documentElement.dataset.theme = 'dark'
} catch (e) {}
