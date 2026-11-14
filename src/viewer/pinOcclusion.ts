// SPDX-License-Identifier: AGPL-3.0-only
// Whether a pin's spot can be seen: the first surface along the ray from the
// camera to it is the spot itself, give or take a slack, or something nearer
// is in the way.
//
// On a mesh the ray meets the pin's own triangle a rounding error in front
// of it, and a small slack does. A point cloud has no triangles: a ray is met
// by the point nearest the eye within a pick radius of it (cloudPick.ts). On
// a surface seen at a grazing angle that is a point well in front of the pin
// on the same surface — the ray runs close above the surface for a long way
// before it reaches the pin, r * tan(angle) in depth for a radius r — and a
// pin plainly on the visible surface would be taken for one behind it. So on
// a cloud the slack grows with the pick radius and with how obliquely the
// surface met is seen.

/** The flattest a surface is taken to be seen, as the cosine between the ray
 *  and its normal: past this the slack stops growing (about 84 degrees),
 *  so a pin behind a wall seen edge-on is not let through by any distance. */
export const MIN_FACING = 0.1

/** How far short of a pin the first surface along its ray may be for the pin
 *  still to count as seen. `base` is the mesh's slack; `cloud` is the pick
 *  radius at the hit and |cos| between the ray and the normal of the point
 *  met, for a point cloud. The radius is added once over the angle's share
 *  for the cloud's own roughness: the point met is any of those within it. */
export function occlusionSlack(base: number, cloud: { radius: number; facing: number } | null): number {
  if (!cloud) return base
  const c = Math.min(1, Math.max(MIN_FACING, Math.abs(cloud.facing)))
  const tan = Math.sqrt(1 - c * c) / c
  return base + cloud.radius * (1 + tan)
}

/** Whether the pin is seen: nothing met along its ray (`hitDistance`
 *  undefined), or what was met no nearer than the pin less the slack. */
export function pinSeen(hitDistance: number | undefined, pinDistance: number, slack: number): boolean {
  return hitDistance === undefined || hitDistance >= pinDistance - slack
}
