import type { Checkpoint, Condition, RiskKey, RiskLevel } from '../types'

export interface RiskStyle {
  level: RiskLevel
  key: RiskKey
  label: string
  color: string
}

// Must match the --color-risk-* tokens in index.css.
export const RISK: readonly RiskStyle[] = [
  { level: 0, key: 'low', label: 'Low', color: '#2f9e6e' },
  { level: 1, key: 'moderate', label: 'Moderate', color: '#e3b505' },
  { level: 2, key: 'high', label: 'High', color: '#f07c1b' },
  { level: 3, key: 'severe', label: 'Severe', color: '#d62839' },
  { level: 4, key: 'no_travel', label: 'No Travel', color: '#7a1fa2' },
]

export const riskColor = (level: RiskLevel) => RISK[level].color

export const CONDITION_LABEL: Record<Condition, string> = {
  wind: 'Wind',
  rain: 'Rain',
  snow: 'Snow',
}

const READING: Record<Condition, { digits: number; unit: string; noTravelAbove?: number }> = {
  wind: { digits: 1, unit: 'mph' },
  rain: { digits: 2, unit: 'in/hr', noTravelAbove: 1.0 },
  snow: { digits: 1, unit: 'in/hr', noTravelAbove: 3.0 },
}

/**
 * A reading at the forecast's own precision, truncated rather than rounded so the
 * number shown never lands across a threshold from its risk level (24.96 mph is Low
 * and reads "24.9 mph", never "25 mph"). Bands include their lower bound, so
 * truncation is always safe, except just above the strict "> 1.00" rain and "> 3.0"
 * snow No Travel limits, where one more digit keeps "1.004" from reading as "1.00".
 */
export function formatReading(condition: Condition, value: number): string {
  const { digits, unit, noTravelAbove } = READING[condition]
  const truncate = (d: number) => Math.floor(value * 10 ** d + 1e-9) / 10 ** d
  let shown = truncate(digits)
  let d = digits
  if (noTravelAbove !== undefined && value > noTravelAbove && shown <= noTravelAbove) {
    d = digits + 1
    shown = truncate(d)
  }
  return `${shown.toFixed(d)}\u00a0${unit}`
}

const ALL_CONDITIONS: Condition[] = ['wind', 'rain', 'snow']

/**
 * A checkpoint's readings, led by whatever set its risk level, so the cause survives
 * when a narrow row truncates the end: "Snow 1.4 in/hr · wind 24.9 mph".
 */
export function readingsLine(cp: Checkpoint): string {
  const value: Record<Condition, number> = {
    wind: cp.weather.wind_mph,
    rain: cp.weather.rain_in_hr,
    snow: cp.weather.snow_in_hr,
  }
  const drivers = cp.risk.drivers
  const order = [...drivers, ...ALL_CONDITIONS.filter((c) => !drivers.includes(c))]
  const text = order
    .filter((c) => c === 'wind' || drivers.includes(c) || value[c] > 0)
    .map((c) => `${CONDITION_LABEL[c].toLowerCase()} ${formatReading(c, value[c])}`)
    .join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
