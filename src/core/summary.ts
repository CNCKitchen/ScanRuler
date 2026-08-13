import type { FitSettings, SigmaPreset } from './types'

export const SIGMA_LABELS: Record<SigmaPreset, string> = {
  0: 'All points',
  3: '3 sigma',
  2: '2 sigma',
  1: '1 sigma',
}

export interface DoneElement {
  id: number
  name: string
  center: [number, number, number]
  diameter: number
}

export interface Pair {
  a: DoneElement
  b: DoneElement
  dist: number
}

export function pairDistances(elements: DoneElement[]): Pair[] {
  const out: Pair[] = []
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i]
      const b = elements[j]
      const dist = Math.sqrt(
        (a.center[0] - b.center[0]) ** 2 +
          (a.center[1] - b.center[1]) ** 2 +
          (a.center[2] - b.center[2]) ** 2,
      )
      out.push({ a, b, dist })
    }
  }
  return out
}

export function buildSummary(
  fileName: string,
  settings: FitSettings,
  elements: DoneElement[],
  pairs: Pair[],
): string {
  const lines = [
    `3D Scan Evaluator — ${fileName}`,
    `Method: Gaussian best-fit, used points: ${SIGMA_LABELS[settings.sigma]}`,
  ]
  for (const el of elements) lines.push(`${el.name}: Ø ${el.diameter.toFixed(4)} mm`)
  for (const p of pairs) lines.push(`${p.a.name} ↔ ${p.b.name}: ${p.dist.toFixed(4)} mm`)
  return lines.join('\n')
}
