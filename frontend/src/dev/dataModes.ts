/**
 * Dev-only data modes for stress-testing the UI (?data=worst etc.).
 *
 * Every mode enters through the API boundary (api.ts), never through component code:
 * a real plan is fetched once and reshaped here, so geometry stays real while the
 * values the UI renders become the realistic worst case. Never imported in production.
 */
import type { Checkpoint, Place, RiskKey, RiskLevel, RouteOption, TripPlan } from '../types'

export const DATA_MODES = ['demo', 'worst', 'one', 'huge', 'none'] as const
export type DataMode = (typeof DATA_MODES)[number]

export const MODE_LABEL: Record<DataMode, string> = {
  demo: 'Demo data',
  worst: 'Worst case',
  one: 'One route',
  huge: '1,000 checkpoints',
  none: 'No route',
}

export function currentMode(): DataMode {
  const value = new URLSearchParams(window.location.search).get('data')
  return (DATA_MODES as readonly string[]).includes(value ?? '') ? (value as DataMode) : 'demo'
}

export function setMode(mode: DataMode) {
  const url = new URL(window.location.href)
  if (mode === 'demo') url.searchParams.delete('data')
  else url.searchParams.set('data', mode)
  window.history.replaceState(null, '', url)
}

const KEYS: RiskKey[] = ['low', 'moderate', 'high', 'severe', 'no_travel']
const LABELS = ['Low', 'Moderate', 'High', 'Severe', 'No Travel']

/** Weather that produces each level for a 50,000 lb load, with the driver(s) it names. */
function weatherFor(level: RiskLevel, k: number): Pick<Checkpoint, 'weather' | 'risk'> {
  const nullish = k % 7 === 3 // partial data: some checkpoints lack temperature and sky
  const base = {
    wind_mph: 24.9, // one tenth below Moderate
    gust_mph: 38.2,
    rain_in_hr: 0.09,
    snow_in_hr: 0,
    temp_f: nullish ? null : 71,
    weather_code: nullish ? null : 2,
  }
  const factors = (wind: RiskLevel, rain: RiskLevel, snow: RiskLevel, adjusted = false) => [
    { condition: 'wind' as const, level: wind, value: base.wind_mph, load_adjusted: adjusted },
    { condition: 'rain' as const, level: rain, value: base.rain_in_hr, load_adjusted: false },
    { condition: 'snow' as const, level: snow, value: base.snow_in_hr, load_adjusted: false },
  ]
  let f = factors(0, 0, 0)
  if (level === 1) {
    base.rain_in_hr = 0.12
    f = factors(0, 1, 0)
  } else if (level === 2) {
    base.snow_in_hr = 1.4
    base.temp_f = nullish ? null : -23
    base.weather_code = nullish ? null : 75
    f = factors(0, 0, 2)
  } else if (level === 3) {
    base.wind_mph = 38 // High on its own; Severe because the load is over 40,000 lb
    base.gust_mph = 61.4
    f = factors(3, 0, 0, true)
  } else if (level === 4) {
    // Every condition at No Travel at once: the longest possible reason text.
    Object.assign(base, { wind_mph: 74.6, gust_mph: 96.3, rain_in_hr: 2.35, snow_in_hr: 4.2 })
    base.temp_f = nullish ? null : -9
    base.weather_code = nullish ? null : 99
    f = factors(4, 4, 4) // >=55 mph is No Travel for any load, so not load-adjusted
  }
  f.sort((a, b) => b.level - a.level)
  return {
    weather: base,
    risk: {
      level,
      label: LABELS[level],
      drivers: level === 0 ? [] : f.filter((x) => x.level === level).map((x) => x.condition),
      factors: f,
    },
  }
}

function withLevels(route: RouteOption, levelAt: (k: number, n: number) => RiskLevel): RouteOption {
  const n = route.checkpoints.length
  return {
    ...route,
    checkpoints: route.checkpoints.map((cp, k) => ({ ...cp, ...weatherFor(levelAt(k, n), k) })),
  }
}

function withExposure(route: RouteOption): RouteOption {
  const miles = Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<RiskKey, number>
  let weighted = 0
  let total = 0
  for (const cp of route.checkpoints) {
    const covered = cp.covers_miles[1] - cp.covers_miles[0]
    miles[KEYS[cp.risk.level]] += covered
    weighted += cp.risk.level * covered
    total += covered
  }
  for (const k of KEYS) miles[k] = Math.round(miles[k] * 10) / 10
  return {
    ...route,
    exposure: {
      miles,
      avg_risk: total ? Math.round((weighted / total) * 100) / 100 : 0,
      max_level: Math.max(0, ...route.checkpoints.map((c) => c.risk.level)) as RiskLevel,
    },
  }
}

/** Same lexicographic ranking as backend/planner/recommendation.py. */
function rank(plan: TripPlan): TripPlan {
  const key = (r: RouteOption) => [
    r.exposure.miles.no_travel,
    r.exposure.miles.severe,
    r.exposure.miles.high,
    r.exposure.avg_risk,
    Math.round(r.duration_s),
  ]
  const criteria = ['no_travel_miles', 'severe_miles', 'high_miles', 'avg_risk', 'duration_s'] as const
  const order = [...plan.routes].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    const i = ka.findIndex((v, j) => v !== kb[j])
    return i < 0 ? 0 : ka[i] - kb[i]
  })
  const best = order[0]
  return {
    ...plan,
    routes: plan.routes.map((r) => ({ ...r, rank: order.indexOf(r) + 1, recommended: r === best })),
    recommendation: {
      route: best.id,
      ranking: order.map((r) => r.id),
      comparisons: order.slice(1).map((other) => {
        const kb = key(best)
        const ko = key(other)
        const i = kb.findIndex((v, j) => v !== ko[j])
        return {
          route: other.id,
          criterion: i < 0 ? null : criteria[i],
          recommended_value: i < 0 ? null : kb[i],
          other_value: i < 0 ? null : ko[i],
        }
      }),
      all_routes_blocked: plan.routes.every((r) => r.exposure.miles.no_travel > 0),
    },
  }
}

/** Stretch a route's mileage and drive time: a cross-country haul on real geometry. */
function stretch(route: RouteOption, departureMs: number, miScale: number, tScale: number): RouteOption {
  const at = (s: number) => new Date(departureMs + s * 1000).toISOString()
  return {
    ...route,
    distance_mi: Math.round(route.distance_mi * miScale * 10) / 10,
    duration_s: Math.round(route.duration_s * tScale),
    arrival_time: at(route.duration_s * tScale),
    geometry: {
      ...route.geometry,
      miles: route.geometry.miles.map((m) => m * miScale),
      elapsed_s: route.geometry.elapsed_s.map((s) => s * tScale),
    },
    checkpoints: route.checkpoints.map((cp) => ({
      ...cp,
      mile: Math.round(cp.mile * miScale * 10) / 10,
      covers_miles: [cp.covers_miles[0] * miScale, cp.covers_miles[1] * miScale],
      elapsed_s: Math.round(cp.elapsed_s * tScale),
      eta: at(cp.elapsed_s * tScale),
    })),
  }
}

/** Subdivide each checkpoint's stretch so a route carries ~340 checkpoints. */
function densify(route: RouteOption, departureMs: number, target: number): RouteOption {
  const cps = route.checkpoints
  const per = Math.max(1, Math.ceil(target / cps.length))
  const out: Checkpoint[] = []
  for (let i = 0; i < cps.length; i++) {
    const a = cps[i]
    const b = cps[Math.min(i + 1, cps.length - 1)]
    const parts = i === cps.length - 1 ? 1 : per
    for (let p = 0; p < parts; p++) {
      const t = p / parts
      const lerp = (x: number, y: number) => x + (y - x) * t
      const elapsed = lerp(a.elapsed_s, b.elapsed_s)
      out.push({
        ...a,
        index: out.length,
        mile: Math.round(lerp(a.mile, b.mile) * 10) / 10,
        lat: lerp(a.lat, b.lat),
        lon: lerp(a.lon, b.lon),
        elapsed_s: Math.round(elapsed),
        eta: new Date(departureMs + elapsed * 1000).toISOString(),
      })
    }
  }
  const miles = out.map((c) => c.mile)
  out.forEach((c, k) => {
    c.covers_miles = [
      k === 0 ? 0 : (miles[k - 1] + miles[k]) / 2,
      k === out.length - 1 ? route.distance_mi : (miles[k] + miles[k + 1]) / 2,
    ]
  })
  return { ...route, checkpoints: out }
}

const WORST_ROADS: string[][] = [
  ['I-635', 'I-35E', 'US-287'], // three-digit interstate, letter suffix, US route
  ['Ronald Reagan Memorial Tollway', 'Dwight D. Eisenhower Highway', 'TX-114'],
  [], // only local roads
]

export function transformPlan(plan: TripPlan, mode: DataMode): TripPlan {
  const dep = Date.parse(plan.request.departure_time)
  if (mode === 'one') {
    const only = { ...plan.routes[0], recommended: true, rank: 1 }
    return {
      ...plan,
      routes: [only],
      recommendation: { route: only.id, ranking: [only.id], comparisons: [], all_routes_blocked: false },
      heatmap: null,
      warnings: [
        'The corridor heatmap is unavailable right now. The Open-Meteo weather service is at its request limit. Try again in a minute.',
      ],
    }
  }
  if (mode === 'huge') {
    const routes = plan.routes.map((r) =>
      withExposure(
        // Weather changes in ~120 mi stretches (12 checkpoints), as real systems do.
        withLevels(densify(r, dep, 340), (k) => ([0, 1, 2, 0, 3, 1, 0, 4, 2, 0] as RiskLevel[])[Math.floor(k / 12) % 10]),
      ),
    )
    return rank({ ...plan, routes, request: { ...plan.request, sample_interval_mi: 10 } })
  }
  if (mode !== 'worst') return plan

  // Worst case: a ~2,800 mi haul (one route past the 48 h horizon), 50,000 lb at the
  // cap, every risk level, long place and road names, partial weather data.
  const patterns: ((k: number, n: number) => RiskLevel)[] = [
    (k, n) => {
      const f = k / n
      return (f < 0.2 ? 0 : f < 0.3 ? 1 : f < 0.45 ? 2 : f < 0.6 ? 3 : f < 0.7 ? 4 : 0) as RiskLevel
    },
    (k, n) => (k / n > 0.15 && k / n < 0.75 ? (k % 9 === 4 ? 4 : 3) : k % 5 === 0 ? 1 : 0) as RiskLevel,
    (k) => (k === 7 ? 4 : 0) as RiskLevel,
  ]
  const routes = plan.routes.map((r, i) =>
    withExposure(
      withLevels(
        { ...stretch(r, dep, 2.78, 2.6), roads: WORST_ROADS[i] ?? [], source: i === 0 ? 'provider' : 'via-point' },
        patterns[i] ?? patterns[0],
      ),
    ),
  )
  return rank({
    ...plan,
    routes,
    request: {
      ...plan.request,
      origin: {
        ...plan.request.origin,
        label: 'Port of Los Angeles Pier 400 Container Terminal, San Pedro',
        detail: 'Los Angeles County, California, US',
      },
      destination: { ...plan.request.destination, label: 'Saint-Jean-sur-Richelieu', detail: 'Québec, CA' },
      load_weight_lb: 50_000,
      sample_interval_mi: 10,
    },
  })
}

/** Place suggestions at their worst: long, accented, punctuated, duplicated names. */
export function transformPlaces(places: Place[], mode: DataMode): Place[] {
  if (mode === 'none') return []
  if (mode !== 'worst') return places
  const at = places[0] ?? { label: '', lat: 39.74, lon: -104.99 }
  const p = (label: string, detail: string): Place => ({ label, detail, lat: at.lat, lon: at.lon })
  return [
    p('Port of Los Angeles Pier 400 Container Terminal, San Pedro', 'Los Angeles County, California, US'),
    p('Saint-Jean-sur-Richelieu', 'Québec, CA'),
    p("Joe's Truck Stop & Diner <I-80 Exit 284>", 'Big Springs, Nebraska, US'),
    p('Springfield', 'Illinois, US'),
    p('Springfield', 'Missouri, US'),
    p('Dallas/Fort Worth International Airport', 'Dallas, Texas, US'),
  ]
}
