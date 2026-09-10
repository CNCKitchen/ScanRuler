// SPDX-License-Identifier: AGPL-3.0-only
// The one number the app knows itself by: `version` in package.json, put in
// at build time by vite.config.ts. Nothing else spells it out — the top bar,
// the imprint and every saved project read it from here — so a release is a
// bump of that one field and a tag (README, "Releases").

export const APP_VERSION: string = __APP_VERSION__
