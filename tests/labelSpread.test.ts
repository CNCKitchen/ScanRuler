// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { spreadLabels } from '../src/viewer/labelSpread'

function label(x: number, y: number, width = 100, height = 22) {
  return {
    style: { display: '', transform: `translate(${x}px, ${y}px)`, top: '' },
    offsetWidth: width,
    offsetHeight: height,
  }
}

function layout(labels: ReturnType<typeof label>[]) {
  spreadLabels({ querySelectorAll: () => labels } as unknown as HTMLElement)
}

describe('viewport label placement', () => {
  it.each([
    { y: [13.934188592515495, 8.26750142268073], offset: -18.333312830165234 },
    // These coordinates also survive the browser's CSS transform serialization.
    { y: [11.4136, 9.35618], offset: -21.94258 },
  ])('terminates when rounding leaves labels at $y overlapping', async ({ y, offset }) => {
    // Run the actual implementation in a worker: a synchronous infinite loop
    // would otherwise prevent Vitest's own timeout from firing.
    const source = readFileSync(new URL('../src/viewer/labelSpread.ts', import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const spread = new Function('exports', workerData.compiled + '; return exports.spreadLabels;')({});
      const label = y => ({
        style: { display: '', transform: 'translate(100px, ' + y + 'px)', top: '' },
        offsetWidth: 100, offsetHeight: 22,
      });
      const labels = workerData.y.map(label);
      for (let frame = 0; frame < 100; frame++) {
        spread({ querySelectorAll: () => labels });
      }
      parentPort.postMessage(labels.map(el => el.style.top));
    `, { eval: true, execArgv: [], workerData: { compiled, y } })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const offsets = await new Promise<string[]>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Label placement did not terminate')), 2000)
        worker.once('message', resolve)
        worker.once('error', reject)
      })
      expect(offsets[0]).toBe('')
      expect(parseFloat(offsets[1])).toBeCloseTo(offset, 10)
    } finally {
      clearTimeout(timer)
      await worker.terminate()
    }
  })

  it('stacks overlapping labels upward with the requested gap', () => {
    const labels = [label(100, 100), label(100, 100), label(100, 100)]
    layout(labels)
    expect(labels.map(el => el.style.top)).toEqual(['', '-24px', '-48px'])
    layout(labels)
    expect(labels.map(el => el.style.top)).toEqual(['', '-24px', '-48px'])
  })

  it('clears another label after being pushed into it', () => {
    const labels = [label(50, 100), label(150, 90), label(100, 80)]
    layout(labels)
    expect(labels.map(el => el.style.top)).toEqual(['', '-14px', '-28px'])
  })

  it('revisits earlier labels after a later collision moves a label into them', () => {
    const labels = [
      label(275, 110, 160, 10),
      label(75, 190, 120, 60),
      label(125, 180, 100, 60),
      label(425, 110, 140, 40),
      label(150, 180, 120, 20),
    ]
    // A single pass leaves the first label at -27px: the last obstacle
    // pushes it into a label already visited. It must move again to clear it.
    layout(labels)
    expect(labels.map(el => el.style.top)).toEqual(['-41px', '', '-52px', '', '-94px'])
  })

  it('leaves separated labels in place and clears obsolete offsets', () => {
    const labels = [label(0, 100), label(200, 100), label(0, 20)]
    labels[0].style.top = '-24px'
    layout(labels)
    expect(labels.map(el => el.style.top)).toEqual(['', '', ''])
  })

  it('ignores hidden labels and resets the sole visible label', () => {
    const labels = [label(100, 100), label(100, 100)]
    labels[0].style.display = 'none'
    labels[1].style.top = '-24px'
    layout(labels)
    expect(labels[1].style.top).toBe('')
    layout([])
  })
})
