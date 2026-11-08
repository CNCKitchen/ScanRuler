// SPDX-License-Identifier: AGPL-3.0-only
// The nearest-face search of the deviation map on the GPU, where WebGPU is
// there to run it. Every scan vertex walks the reference's own tree — the
// node buffer three-mesh-bvh built, uploaded as it stands — in a compute
// shader, and comes back with the face it lies nearest. Only the face: the
// reading itself, distance and sign, is still resolved on the CPU in doubles
// (NominalSurface.closestOnFace), so the map is the one the CPU search gives,
// short of a near tie between two faces the shader's single precision splits
// the other way — and there the two readings agree to that precision anyway.
// Anything missing or failing answers null, and the CPU search runs instead.
//
// Timed in Chrome on a desktop GPU against an icosphere reference, the scan a
// noisy sphere lying on it: 655k vertices on 328k faces, 990 ms on the CPU
// tree and 71 ms here, search and readings together; 2.6M on 1.3M, 5.2 s and
// 0.28 s. A scan standing well off the reference, where the CPU walk opens
// far more of the tree, went from 24 s to 0.11 s. The readings agreed to
// 3e-6 mm throughout.

import { rigidApply, type Rigid } from './rigid'
import type { NominalSurface } from './surface'

/** Below this many scan vertices the CPU tree finishes before a GPU is even
 *  set up, and the map is not worth sending out for. */
export const GPU_MIN_VERTICES = 100_000

/** Vertices per dispatch: each is awaited before the next goes out, so no
 *  one submission holds the GPU long enough for the driver to reset it, and
 *  progress has somewhere to come from. */
const CHUNK = 1 << 18

/** A face index no search found: the stack ran out, or nothing was there. */
const NO_FACE = 0xffffffff

const SHADER = /* wgsl */ `
struct Params { count: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> nodes: array<u32>;
@group(0) @binding(1) var<storage, read> positions: array<f32>;
@group(0) @binding(2) var<storage, read> tris: array<u32>;
@group(0) @binding(3) var<storage, read> points: array<f32>;
@group(0) @binding(4) var<storage, read_write> faces: array<u32>;
@group(0) @binding(5) var<uniform> params: Params;

fn boxDist2(n: u32, p: vec3f) -> f32 {
  let lo = vec3f(bitcast<f32>(nodes[n]), bitcast<f32>(nodes[n + 1u]), bitcast<f32>(nodes[n + 2u]));
  let hi = vec3f(bitcast<f32>(nodes[n + 3u]), bitcast<f32>(nodes[n + 4u]), bitcast<f32>(nodes[n + 5u]));
  let d = max(max(lo - p, p - hi), vec3f(0.0));
  return dot(d, d);
}

fn vertex(i: u32) -> vec3f {
  return vec3f(positions[i * 3u], positions[i * 3u + 1u], positions[i * 3u + 2u]);
}

// Ericson's closest point on a triangle, as squared distance.
fn triDist2(p: vec3f, a: vec3f, b: vec3f, c: vec3f) -> f32 {
  let ab = b - a; let ac = c - a; let ap = p - a;
  let d1 = dot(ab, ap); let d2 = dot(ac, ap);
  if (d1 <= 0.0 && d2 <= 0.0) { return dot(ap, ap); }
  let bp = p - b;
  let d3 = dot(ab, bp); let d4 = dot(ac, bp);
  if (d3 >= 0.0 && d4 <= d3) { return dot(bp, bp); }
  let vc = d1 * d4 - d3 * d2;
  if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
    let q = a + ab * (d1 / (d1 - d3)); let e = p - q; return dot(e, e);
  }
  let cp = p - c;
  let d5 = dot(ab, cp); let d6 = dot(ac, cp);
  if (d6 >= 0.0 && d5 <= d6) { return dot(cp, cp); }
  let vb = d5 * d2 - d1 * d6;
  if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
    let q = a + ac * (d2 / (d2 - d6)); let e = p - q; return dot(e, e);
  }
  let va = d3 * d6 - d5 * d4;
  if (va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0) {
    let q = b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6))); let e = p - q; return dot(e, e);
  }
  // Inside: the distance to the triangle's plane. The barycentric products
  // above lose their digits in single precision on a thin triangle, and the
  // point they gave stood off the face by more than a neighbour's edge did.
  let n = cross(ab, ac);
  let h = dot(ap, n);
  return h * h / dot(n, n);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let p = vec3f(points[i * 3u], points[i * 3u + 1u], points[i * 3u + 2u]);
  var best = 3.4e38;
  var bestFace = 0xffffffffu;
  var stack: array<u32, 64>;
  stack[0] = 0u;
  var sp = 1u;
  loop {
    if (sp == 0u) { break; }
    sp -= 1u;
    let n = stack[sp];
    if (boxDist2(n, p) >= best) { continue; }
    let info = nodes[n + 7u];
    if ((info >> 16u) == 0xffffu) {
      let first = nodes[n + 6u];
      let end = first + (info & 0xffffu);
      for (var t = first; t < end; t += 1u) {
        let d = triDist2(p, vertex(tris[t * 3u]), vertex(tris[t * 3u + 1u]), vertex(tris[t * 3u + 2u]));
        if (d < best) { best = d; bestFace = t; }
      }
    } else {
      if (sp + 2u > 64u) { bestFace = 0xffffffffu; break; }
      let l = n + 8u;
      let r = nodes[n + 6u];
      let dl = boxDist2(l, p);
      let dr = boxDist2(r, p);
      // The nearer child goes on top, to be opened first.
      if (dl < dr) {
        if (dr < best) { stack[sp] = r; sp += 1u; }
        if (dl < best) { stack[sp] = l; sp += 1u; }
      } else {
        if (dl < best) { stack[sp] = l; sp += 1u; }
        if (dr < best) { stack[sp] = r; sp += 1u; }
      }
    }
  }
  faces[i] = bestFace;
}
`

// The few WebGPU names used here, loosely: the DOM library this project
// builds against does not declare them.
type GPUDeviceLike = any

const STORAGE = 0x80, COPY_DST = 0x08, COPY_SRC = 0x04, UNIFORM = 0x40, MAP_READ = 0x01

let device: Promise<GPUDeviceLike | null> | null = null
let pipeline: any = null

function deviceOf(): Promise<GPUDeviceLike | null> {
  if (device) return device
  device = (async () => {
    const gpu = (globalThis.navigator as any)?.gpu
    if (!gpu) return null
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return null
    const d = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    })
    d.lost.then(() => {
      device = null
      pipeline = null
      held = null
    })
    pipeline = await d.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: d.createShaderModule({ code: SHADER }), entryPoint: 'main' },
    })
    return d
  })().catch(() => null)
  return device
}

/** The reference uploaded, kept for the next map against the same one. */
let held: { surface: NominalSurface; buffers: any[] } | null = null

function upload(d: GPUDeviceLike, data: ArrayBufferView): any {
  const size = Math.max(16, Math.ceil(data.byteLength / 4) * 4)
  const buffer = d.createBuffer({ size, usage: STORAGE | COPY_DST })
  d.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength)
  return buffer
}

function referenceBuffers(d: GPUDeviceLike, surface: NominalSurface): any[] | null {
  if (held?.surface === surface) return held.buffers
  const tree = surface.flatTree()
  if (!tree) return null
  const max = Math.min(d.limits.maxStorageBufferBindingSize, d.limits.maxBufferSize)
  if (Math.max(tree.byteLength, surface.positions.byteLength, surface.index.byteLength) > max) return null
  if (held) for (const b of held.buffers) b.destroy()
  held = { surface, buffers: [upload(d, tree), upload(d, surface.positions), upload(d, surface.index)] }
  return held.buffers
}

/**
 * The nearest reference face for every scan vertex, -1 where the shader could
 * not say, found on the GPU; null when there is no GPU to ask or it failed,
 * for the caller to search on the CPU instead.
 */
export async function gpuNearestFaces(
  surface: NominalSurface,
  scanPositions: Float32Array,
  transform: Rigid,
  onProgress?: (fraction: number) => void,
): Promise<Int32Array | null> {
  const d = await deviceOf()
  if (!d) return null
  try {
    const reference = referenceBuffers(d, surface)
    if (!reference) return null
    const n = scanPositions.length / 3
    const faces = new Int32Array(n)
    const span = Math.min(CHUNK, n)
    const points = d.createBuffer({ size: span * 12, usage: STORAGE | COPY_DST })
    const out = d.createBuffer({ size: span * 4, usage: STORAGE | COPY_SRC })
    const readback = d.createBuffer({ size: span * 4, usage: MAP_READ | COPY_DST })
    const params = d.createBuffer({ size: 16, usage: UNIFORM | COPY_DST })
    const bind = d.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [...reference, points, out, params].map((buffer, binding) => ({ binding, resource: { buffer } })),
    })
    const local = new Float32Array(span * 3)
    const p = new Float64Array(3)
    try {
      for (let start = 0; start < n; start += span) {
        const count = Math.min(span, n - start)
        // Into the reference's frame here, where the transform is in doubles.
        for (let i = 0; i < count; i++) {
          const v = (start + i) * 3
          rigidApply(transform, scanPositions[v], scanPositions[v + 1], scanPositions[v + 2], p)
          local[i * 3] = p[0]; local[i * 3 + 1] = p[1]; local[i * 3 + 2] = p[2]
        }
        d.queue.writeBuffer(points, 0, local.buffer, 0, count * 12)
        d.queue.writeBuffer(params, 0, new Uint32Array([count, 0, 0, 0]))
        d.pushErrorScope('validation')
        const encoder = d.createCommandEncoder()
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind)
        pass.dispatchWorkgroups(Math.ceil(count / 64))
        pass.end()
        encoder.copyBufferToBuffer(out, 0, readback, 0, count * 4)
        d.queue.submit([encoder.finish()])
        const error = await d.popErrorScope()
        if (error) return null
        await readback.mapAsync(MAP_READ, 0, count * 4)
        const got = new Uint32Array(readback.getMappedRange(0, count * 4))
        for (let i = 0; i < count; i++) faces[start + i] = got[i] === NO_FACE ? -1 : got[i]
        readback.unmap()
        onProgress?.((start + count) / n)
      }
    } finally {
      for (const b of [points, out, readback, params]) b.destroy()
    }
    return faces
  } catch {
    return null
  }
}
