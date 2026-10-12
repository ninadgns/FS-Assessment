import type { HeatLayer } from '../types'
import { RISK } from './risk'

interface Stop {
  at: number
  color: string
  alpha: number
}

export interface HeatScale {
  label: string
  unit: string
  max: number
  stops: Stop[]
  /** Risk bands are discrete levels, so colour steps at each whole number. */
  stepped: boolean
  /**
   * Built from hourly totals (rain, snow), which Open-Meteo stamps at the end of the
   * hour they cover. The painter centres these frames on the middle of that hour.
   */
  hourlyTotal: boolean
  /** Legend tick marks, placed at the assessment's risk thresholds. */
  ticks: { at: number; label: string }[]
}

// Alpha rises with severity so calm stretches stay a faint wash and hazards pop.
const RISK_ALPHA = [0.16, 0.5, 0.58, 0.66, 0.74]

export const HEAT_SCALES: Record<HeatLayer, HeatScale> = {
  risk: {
    label: 'Risk',
    unit: 'level',
    max: 4,
    stepped: true,
    hourlyTotal: true,
    stops: RISK.map((r) => ({ at: r.level, color: r.color, alpha: RISK_ALPHA[r.level] })),
    ticks: RISK.map((r) => ({ at: r.level + 0.5, label: r.label })),
  },
  wind: {
    label: 'Wind',
    unit: 'mph',
    max: 65,
    stepped: false,
    hourlyTotal: false,
    stops: [
      { at: 0, color: '#cfe8e3', alpha: 0 },
      { at: 15, color: '#9fd3c7', alpha: 0.2 },
      { at: 25, color: '#4fb0a5', alpha: 0.45 },
      { at: 35, color: '#2b7c99', alpha: 0.6 },
      { at: 45, color: '#3a3f9a', alpha: 0.7 },
      { at: 55, color: '#6a1b9a', alpha: 0.78 },
    ],
    ticks: [25, 35, 45, 55].map((v) => ({ at: v, label: String(v) })),
  },
  rain: {
    label: 'Rain',
    unit: 'in/hr',
    max: 1.25,
    stepped: false,
    hourlyTotal: true,
    stops: [
      { at: 0, color: '#a1d99b', alpha: 0 },
      { at: 0.02, color: '#a1d99b', alpha: 0.3 },
      { at: 0.1, color: '#41ab5d', alpha: 0.5 },
      { at: 0.25, color: '#f2c80f', alpha: 0.62 },
      { at: 0.5, color: '#f57c00', alpha: 0.7 },
      { at: 1.0, color: '#d32f2f', alpha: 0.78 },
    ],
    ticks: [0.1, 0.25, 0.5, 1.0].map((v) => ({ at: v, label: v.toFixed(2).replace(/^0/, '') })),
  },
  snow: {
    label: 'Snow',
    unit: 'in/hr',
    max: 3.75,
    stepped: false,
    hourlyTotal: true,
    stops: [
      { at: 0, color: '#dfe9f5', alpha: 0 },
      { at: 0.1, color: '#bcd2ec', alpha: 0.3 },
      { at: 0.5, color: '#8fb3e0', alpha: 0.5 },
      { at: 1.0, color: '#7b86c9', alpha: 0.62 },
      { at: 2.0, color: '#8a4fb0', alpha: 0.7 },
      { at: 3.0, color: '#b0187d', alpha: 0.78 },
    ],
    ticks: [0.5, 1, 2, 3].map((v) => ({ at: v, label: String(v) })),
  },
}

const LUT_SIZE = 512

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function colorAt(scale: HeatScale, value: number): [number, number, number, number] {
  const { stops } = scale
  if (scale.stepped) {
    const level = Math.min(stops.length - 1, Math.max(0, Math.floor(value)))
    const stop = stops[level]
    // Within a band, opacity builds slightly toward the next threshold.
    const frac = level === stops.length - 1 ? 0 : value - level
    return [...rgb(stop.color), stop.alpha + frac * 0.08]
  }
  if (value <= stops[0].at) return [...rgb(stops[0].color), stops[0].alpha]
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]
    const b = stops[i]
    if (value <= b.at) {
      const t = (value - a.at) / (b.at - a.at)
      const [ar, ag, ab] = rgb(a.color)
      const [br, bg, bb] = rgb(b.color)
      return [ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t, a.alpha + (b.alpha - a.alpha) * t]
    }
  }
  const last = stops.at(-1)!
  return [...rgb(last.color), last.alpha]
}

/** RGBA lookup table over [0, scale.max], for painting thousands of cells per frame. */
export function buildLut(scale: HeatScale): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(LUT_SIZE * 4)
  for (let i = 0; i < LUT_SIZE; i++) {
    const [r, g, b, a] = colorAt(scale, (i / (LUT_SIZE - 1)) * scale.max)
    lut.set([r, g, b, a * 255], i * 4)
  }
  return lut
}

export function lutOffset(scale: HeatScale, value: number): number {
  const i = Math.round((Math.min(Math.max(value, 0), scale.max) / scale.max) * (LUT_SIZE - 1))
  return i * 4
}

/** CSS gradient for the legend bar, consistent with the LUT. */
export function legendGradient(scale: HeatScale): string {
  const parts: string[] = []
  for (let i = 0; i <= 40; i++) {
    const v = (i / 40) * scale.max
    const [r, g, b, a] = colorAt(scale, v)
    // Legend shows colours at full strength so faint low values remain visible.
    const alpha = Math.min(1, 0.25 + a)
    parts.push(`rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha.toFixed(2)}) ${(i / 40) * 100}%`)
  }
  return `linear-gradient(to right, ${parts.join(', ')})`
}
