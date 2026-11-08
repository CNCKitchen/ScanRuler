// SPDX-License-Identifier: AGPL-3.0-only
// A project saved over a file of the same name came down as
// `MyProject.scanruler-2`, which the app would not open (issue 83). A
// project is known by its name with the count a browser adds after the
// extension, and, under any other name, by what it holds: a zip whose first
// member is the manifest.

import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { collectProject, emptySources } from '../src/app/project'
import { packProject } from '../src/core/project/archive'
import { isProjectName, PROJECT_ACCEPT, startsAsProject } from '../src/core/project/manifest'

describe('a project by its name', () => {
  it('takes .scanruler with the count a browser puts after it', () => {
    for (const name of ['MyProject.scanruler', 'MyProject.SCANRULER', 'MyProject.scanruler-2', 'MyProject.scanruler-12', 'MyProject.scanruler (2)', 'MyProject.scanruler(3)', 'MyProject (1).scanruler']) {
      expect(isProjectName(name), name).toBe(true)
    }
  })

  it('takes no other name', () => {
    for (const name of ['MyProject.scanruler.zip', 'MyProject.scanruler-', 'MyProject.scanruler-x', 'MyProject.stl', 'scanruler', 'MyProject.scanrulers']) {
      expect(isProjectName(name), name).toBe(false)
    }
  })

  it('is offered by the Open dialog with the counts too', () => {
    expect(PROJECT_ACCEPT.split(',')).toEqual(expect.arrayContaining(['.scanruler', '.scanruler-2', '.scanruler-9']))
  })
})

describe('a project by what it holds', () => {
  it('is a zip that starts with its manifest', () => {
    const bytes = packProject(collectProject(emptySources(), null, 'test').manifest, [{ name: 'scan.stl', bytes: new Uint8Array(100) }])
    expect(startsAsProject(bytes.subarray(0, 64))).toBe(true)
  })

  it('is no other zip, and no model', () => {
    expect(startsAsProject(zipSync({ 'readme.txt': strToU8('hello'), 'project.json': strToU8('{}') }).subarray(0, 64))).toBe(false)
    expect(startsAsProject(strToU8('solid cube\nfacet normal 0 0 1\n'))).toBe(false)
    expect(startsAsProject(new Uint8Array(10))).toBe(false)
  })
})
