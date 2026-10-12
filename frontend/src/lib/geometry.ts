import type { Checkpoint, RiskLevel, RouteOption } from '../types'

export type LngLat = [number, number]

/** Largest i with values[i] <= x, clamped so that [i, i + 1] is a valid segment. */
function segmentIndex(values: number[], x: number): number {
  let lo = 0
  let hi = values.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (values[mid] <= x) lo = mid
    else hi = mid - 1
  }
  return Math.max(0, lo)
}

function interpolate(route: RouteOption, along: number[], x: number): LngLat {
  const coords = route.geometry.coordinates
  const i = segmentIndex(along, x)
  const span = along[i + 1] - along[i]
  const t = span > 0 ? Math.min(1, Math.max(0, (x - along[i]) / span)) : 0
  const [x0, y0] = coords[i]
  const [x1, y1] = coords[i + 1]
  return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]
}

export const pointAtMile = (route: RouteOption, mile: number) =>
  interpolate(route, route.geometry.miles, mile)

export interface TruckPosition {
  coord: LngLat
  mile: number
  arrived: boolean
}

/** Where the truck is `seconds` after departure (parked at the destination once arrived). */
export function truckPosition(route: RouteOption, seconds: number): TruckPosition {
  const { elapsed_s, miles } = route.geometry
  if (seconds >= route.duration_s) {
    return { coord: route.geometry.coordinates.at(-1)!, mile: route.distance_mi, arrived: true }
  }
  const i = segmentIndex(elapsed_s, seconds)
  const span = elapsed_s[i + 1] - elapsed_s[i]
  const t = span > 0 ? (seconds - elapsed_s[i]) / span : 0
  return {
    coord: interpolate(route, elapsed_s, seconds),
    mile: miles[i] + (miles[i + 1] - miles[i]) * t,
    arrived: false,
  }
}

/** The polyline between two mileposts, with interpolated end points. */
export function sliceByMiles(route: RouteOption, from: number, to: number): LngLat[] {
  const { coordinates, miles } = route.geometry
  const out: LngLat[] = [pointAtMile(route, from)]
  for (let i = 0; i < miles.length; i++) {
    if (miles[i] > from && miles[i] < to) out.push(coordinates[i])
  }
  out.push(pointAtMile(route, to))
  return out
}

export interface RiskStretch {
  level: RiskLevel
  fromMile: number
  toMile: number
  coords: LngLat[]
}

/** Each checkpoint's stretch of road coloured by its risk; equal neighbours are merged. */
export function riskStretches(route: RouteOption): RiskStretch[] {
  const merged: Omit<RiskStretch, 'coords'>[] = []
  for (const cp of route.checkpoints) {
    const [fromMile, toMile] = cp.covers_miles
    const last = merged.at(-1)
    if (last && last.level === cp.risk.level) last.toMile = toMile
    else merged.push({ level: cp.risk.level, fromMile, toMile })
  }
  return merged
    .filter((s) => s.toMile > s.fromMile)
    .map((s) => ({ ...s, coords: sliceByMiles(route, s.fromMile, s.toMile) }))
}

/** The checkpoint whose weather applies at `seconds` after departure. */
export function checkpointAt(route: RouteOption, seconds: number): Checkpoint {
  const cps = route.checkpoints
  let best = cps[0]
  for (const cp of cps) {
    if (Math.abs(cp.elapsed_s - seconds) < Math.abs(best.elapsed_s - seconds)) best = cp
  }
  return best
}

/**
 * Where to pin a route's label: the vertex farthest from the other routes, so labels
 * sit where routes diverge instead of piling up on shared highway.
 */
export function labelAnchor(route: RouteOption, others: RouteOption[]): LngLat {
  const coords = route.geometry.coordinates
  const sample = (r: RouteOption) =>
    r.geometry.coordinates.filter((_, i) => i % 8 === 0)
  const otherPoints = others.flatMap(sample)
  const n = coords.length
  let best = coords[Math.floor(n / 2)]
  let bestScore = -1
  // Skip the ends, where every route converges on the same origin/destination.
  for (let i = Math.floor(n * 0.15); i < Math.ceil(n * 0.85); i += 4) {
    const [x, y] = coords[i]
    let nearest = Infinity
    for (const [ox, oy] of otherPoints) {
      const d = (x - ox) ** 2 + (y - oy) ** 2
      if (d < nearest) nearest = d
    }
    // Mild preference for the middle of the route breaks ties on fully shared routes.
    const centrality = 1 - Math.abs(i / n - 0.5)
    const score = nearest * (0.75 + 0.25 * centrality)
    if (score > bestScore) {
      bestScore = score
      best = coords[i]
    }
  }
  return best
}

export function boundsOf(routes: RouteOption[]): [LngLat, LngLat] {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const r of routes) {
    for (const [x, y] of r.geometry.coordinates) {
      if (x < w) w = x
      if (x > e) e = x
      if (y < s) s = y
      if (y > n) n = y
    }
  }
  return [
    [w, s],
    [e, n],
  ]
}
