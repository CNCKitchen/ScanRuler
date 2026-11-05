// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A viewport's frame loop that goes to sleep when there is nothing to draw.
 *
 * Render-on-demand already skipped the drawing on a still frame, but the
 * loop itself kept asking the browser for a frame sixty times a second, and
 * every one of those ran the owner's tick: a phone held still on a part was
 * waking its CPU for nothing, for as long as the page was open. So after a
 * run of frames with nothing to do the loop stops asking, and the first thing
 * that could change the picture — an invalidate, a hand on the canvas, a key,
 * a resize — wakes it again.
 *
 * Kept apart from the viewport so the sleeping and waking can be tested
 * without a WebGL context.
 */

/** How many frames in a row with nothing to do before the loop sleeps:
 *  half a second at 60 Hz. Long enough that whatever settles a frame or two
 *  after the last change — a hover pass, a grip re-scaled to the zoom, a
 *  layer's tick catching up with the camera — still gets its frames, short
 *  enough that a still screen costs nothing soon after. */
export const IDLE_FRAMES = 30

export interface FrameScheduler {
  request(cb: () => void): number
  cancel(id: number): void
}

const browserFrames: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
}

export class FrameLoop {
  private id = 0
  private idle = 0
  private stopped = false

  /** `step` runs once a frame and says whether the frame had anything to do
   *  — drew, or has something under way that will want the next one. */
  constructor(
    private step: () => boolean,
    private frames: FrameScheduler = browserFrames,
  ) {}

  /** Whether a frame is asked for: false while the loop sleeps. */
  get awake(): boolean {
    return this.id !== 0
  }

  /** Something may have changed: run frames again, if they had stopped,
   *  and count the idle run from here. Cheap enough to call on every
   *  invalidate and every pointer move. */
  wake = (): void => {
    this.idle = 0
    if (this.id !== 0 || this.stopped) return
    this.id = this.frames.request(this.tick)
  }

  /** For good: the viewport is going. */
  stop(): void {
    this.stopped = true
    if (this.id !== 0) this.frames.cancel(this.id)
    this.id = 0
  }

  private tick = (): void => {
    // Asked for ahead of the step, so a wake from inside it finds the next
    // frame already asked for rather than asking a second time.
    this.id = this.frames.request(this.tick)
    if (this.step()) this.idle = 0
    else if (++this.idle >= IDLE_FRAMES) {
      this.frames.cancel(this.id)
      this.id = 0
    }
  }
}
