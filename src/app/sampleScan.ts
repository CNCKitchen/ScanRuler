// SPDX-License-Identifier: AGPL-3.0-only
// A scan to try the app on, for someone with no scanner: it ships with the
// build under public/samples/, so a self-hosted copy has it too, and opens by
// the path a dropped file takes.

/** The file under public/samples/. */
const SAMPLE_NAME = 'fridgeBracket_01-reduced.3mf'

/** What the start page says of the sample. */
export const SAMPLE_DETAIL = 'A fridge bracket, 288,582 triangles, 4 MB'

/** The sample as a file to open, from where this build is served. */
export async function fetchSampleScan(base: string = import.meta.env.BASE_URL): Promise<File> {
  let res: Response
  try {
    res = await fetch(`${base.replace(/\/*$/, '/')}samples/${SAMPLE_NAME}`)
  } catch {
    throw new Error('The sample scan could not be fetched. Check the connection and try again.')
  }
  if (!res.ok) throw new Error(`The sample scan could not be fetched: ${res.status} ${res.statusText}`.trimEnd() + '.')
  return new File([await res.arrayBuffer()], SAMPLE_NAME)
}
