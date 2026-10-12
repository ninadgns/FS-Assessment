import { describe, expect, it } from 'vitest'
import type { Checkpoint, Heatmap, RiskLevel, RouteOption } from '../types'
import { formatDuration, formatMiles } from './format'
import { riskStretches, sliceByMiles, truckPosition } from './geometry'
import { paintHeatmap } from './heatPainter'
import { buildLut, HEAT_SCALES, lutOffset } from './heatScales'
import { reasonText } from './reasons'
import { formatReading } from './risk'

function checkpoint(index: number, mile: number, level: RiskLevel, covers: [number, number]): Checkpoint {
  return {
    index,
    mile,
    lat: 40,
    lon: -100 + mile / 50,
    eta: '2026-10-10T14:00:00Z',
    elapsed_s: mile * 72, // 50 mph
    covers_miles: covers,
    weather: { wind_mph: 5, gust_mph: 9, rain_in_hr: 0, snow_in_hr: 0, temp_f: 50, weather_code: 0 },
    risk: { level, label: '', drivers: [], factors: [] },
  }
}

/** A 100-mile route due east at 50 mph with vertices every 25 miles. */
const route: RouteOption = {
  id: 'A',
  name: 'via I-70',
  roads: ['I-70'],
  source: 'provider',
  distance_mi: 100,
  duration_s: 7200,
  arrival_time: '2026-10-10T16:00:00Z',
  rank: 1,
  recommended: true,
  exposure: { miles: { low: 100, moderate: 0, high: 0, severe: 0, no_travel: 0 }, avg_risk: 0, max_level: 0 },
  geometry: {
    coordinates: [0, 25, 50, 75, 100].map((m) => [-100 + m / 50, 40] as [number, number]),
    elapsed_s: [0, 1800, 3600, 5400, 7200],
    miles: [0, 25, 50, 75, 100],
  },
  checkpoints: [
    checkpoint(0, 0, 0, [0, 25]),
    checkpoint(1, 50, 3, [25, 75]),
    checkpoint(2, 100, 3, [75, 100]),
  ],
}

describe('truckPosition', () => {
  it('interpolates along the route by elapsed time', () => {
    const pos = truckPosition(route, 2700) // 45 minutes in
    expect(pos.mile).toBeCloseTo(37.5)
    expect(pos.coord[0]).toBeCloseTo(-100 + 37.5 / 50)
    expect(pos.arrived).toBe(false)
  })

  it('parks at the destination after arrival', () => {
    expect(truckPosition(route, 9000)).toMatchObject({ mile: 100, arrived: true, coord: [-98, 40] })
  })
})

describe('riskStretches', () => {
  it('merges neighbouring checkpoints with the same level', () => {
    const stretches = riskStretches(route)
    expect(stretches.map((s) => [s.level, s.fromMile, s.toMile])).toEqual([
      [0, 0, 25],
      [3, 25, 100],
    ])
  })

  it('slices geometry with interpolated end points', () => {
    const coords = sliceByMiles(route, 10, 60)
    expect(coords[0][0]).toBeCloseTo(-99.8)
    expect(coords.slice(1, -1)).toEqual([route.geometry.coordinates[1], route.geometry.coordinates[2]])
    expect(coords.at(-1)![0]).toBeCloseTo(-98.8)
  })
})

describe('paintHeatmap', () => {
  const heatmap: Heatmap = {
    bounds: [-101, 39, -99, 41],
    nx: 2,
    ny: 2,
    cell_km: 20,
    cols: [1],
    rows: [0],
    opacity: [0.5],
    times: [0, 3600],
    layers: { risk: [[1], [3]], wind: [[0], [0]], rain: [[0], [0]], snow: [[0], [0]] },
  }

  it('centres hourly totals on the hour they cover and writes only corridor cells', () => {
    const image = { data: new Uint8ClampedArray(16), width: 2, height: 2 } as ImageData
    // Frame 0 covers the hour before t=0 and frame 1 the hour before t=3600, so at t=0
    // the painter sits halfway between their midpoints: risk 2.0 (High).
    paintHeatmap(image, heatmap, 'risk', 0)
    const lut = buildLut(HEAT_SCALES.risk)
    const o = lutOffset(HEAT_SCALES.risk, 2)
    expect(Array.from(image.data.slice(4, 7))).toEqual(Array.from(lut.slice(o, o + 3)))
    expect(image.data[7]).toBe(Math.round(lut[o + 3] * 0.5)) // corridor-edge fade
    expect(image.data[0] + image.data[3] + image.data[11] + image.data[15]).toBe(0)
  })

  it('interpolates instantaneous values at their timestamps', () => {
    const windy = { ...heatmap, layers: { ...heatmap.layers, wind: [[20], [40]] } }
    const image = { data: new Uint8ClampedArray(16), width: 2, height: 2 } as ImageData
    paintHeatmap(image, windy, 'wind', 1800)
    const o = lutOffset(HEAT_SCALES.wind, 30)
    const lut = buildLut(HEAT_SCALES.wind)
    expect(Array.from(image.data.slice(4, 7))).toEqual(Array.from(lut.slice(o, o + 3)))
  })
})

describe('reasonText', () => {
  it('names the deciding criterion', () => {
    expect(reasonText({ route: 'B', criterion: 'severe_miles', recommended_value: 0, other_value: 42 })).toBe(
      `No Severe weather; Route B has ${formatMiles(42)} of it.`,
    )
    expect(
      reasonText({ route: 'C', criterion: 'duration_s', recommended_value: 3600, other_value: 9000 }),
    ).toBe(`Same weather exposure as Route C, and ${formatDuration(5400)} faster.`)
  })
})

describe('formatReading', () => {
  const nb = (s: string) => s.replace(' ', '\u00a0')
  it('never shows a number across the threshold from its risk level', () => {
    expect(formatReading('wind', 24.96)).toBe(nb('24.9 mph')) // Low, not "25"
    expect(formatReading('wind', 25)).toBe(nb('25.0 mph'))
    expect(formatReading('rain', 0.099)).toBe(nb('0.09 in/hr')) // Low, not "0.10"
    expect(formatReading('snow', 0.49)).toBe(nb('0.4 in/hr')) // Low, not "0.5"
  })

  it('adds a digit just above the strict No Travel limits', () => {
    expect(formatReading('rain', 1.0)).toBe(nb('1.00 in/hr')) // Severe
    expect(formatReading('rain', 1.004)).toBe(nb('1.004 in/hr')) // No Travel
    expect(formatReading('snow', 3.04)).toBe(nb('3.04 in/hr'))
  })
})
