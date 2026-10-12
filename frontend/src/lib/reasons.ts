import type { Comparison } from '../types'
import { formatDuration, formatMiles } from './format'

/** One sentence per rival route, naming the rule that decided between them. */
export function reasonText(c: Comparison): string {
  const rival = `Route ${c.route}`
  const best = c.recommended_value ?? 0
  const other = c.other_value ?? 0
  const mi = (v: number) => formatMiles(v, v < 10 ? 1 : 0)
  switch (c.criterion) {
    case 'no_travel_miles':
      return best === 0
        ? `Avoids No Travel conditions; ${rival} crosses ${mi(other)} of them.`
        : `${mi(best)} of No Travel conditions versus ${mi(other)} on ${rival}.`
    case 'severe_miles':
      return best === 0
        ? `No Severe weather; ${rival} has ${mi(other)} of it.`
        : `${mi(best)} of Severe weather versus ${mi(other)} on ${rival}.`
    case 'high_miles':
      return best === 0
        ? `No High-risk miles; ${rival} has ${mi(other)}.`
        : `${mi(best)} of High risk versus ${mi(other)} on ${rival}.`
    case 'avg_risk':
      return `Same Severe and High exposure as ${rival}, but lower average risk (${best.toFixed(2)} vs ${other.toFixed(2)}).`
    case 'duration_s':
      return `Same weather exposure as ${rival}, and ${formatDuration(other - best)} faster.`
    default:
      return `Identical to ${rival} on every measure.`
  }
}
