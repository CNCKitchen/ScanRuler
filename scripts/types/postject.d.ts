// SPDX-License-Identifier: AGPL-3.0-only
// postject ships no types. This is the part of its API scripts/bundle-agent.ts uses: it writes a resource (here Node's single-executable blob) into an executable.
declare module 'postject' {
  export interface InjectOptions {
    /** The sentinel the runtime looks for to know a blob is injected. */
    sentinelFuse?: string
    /** The Mach-O segment to put the resource in (macOS only). */
    machoSegmentName?: string | undefined
    /** Replace the resource when the executable already has one of this name. */
    overwrite?: boolean
  }
  export function inject(filename: string, resourceName: string, resourceData: Buffer, options?: InjectOptions): Promise<void>
}
