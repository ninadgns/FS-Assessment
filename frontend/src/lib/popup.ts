import type { Checkpoint, RouteOption } from '../types'
import { describeWeather, formatClock, formatPounds } from './format'
import { CONDITION_LABEL, formatReading, riskColor } from './risk'

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Plain-language reason for a checkpoint's risk level. */
export function riskReason(cp: Checkpoint, loadLb: number): string {
  if (cp.risk.level === 0) return 'All conditions below risk thresholds.'
  const parts = cp.risk.factors
    .filter((f) => cp.risk.drivers.includes(f.condition))
    .map((f, i) => {
      const name = CONDITION_LABEL[f.condition]
      const text = `${i === 0 ? name : name.toLowerCase()} ${formatReading(f.condition, f.value)}`
      return f.load_adjusted ? `${text} with a ${formatPounds(loadLb)} load` : text
    })
  // "Wind 74.6 mph, rain 2.35 in/hr, and snow 4.2 in/hr."
  return `${list.format(parts)}.`
}

const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })

export function checkpointPopupHtml(route: RouteOption, cp: Checkpoint, loadLb: number): string {
  const w = cp.weather
  const color = riskColor(cp.risk.level)
  const chip =
    cp.risk.level === 4
      ? `<span class="barricade inline-block h-2.5 w-2.5 rounded-[2px]"></span>`
      : `<span class="inline-block h-2.5 w-2.5 rounded-full" style="background:${color}"></span>`
  const row = (label: string, value: string) =>
    `<div class="flex justify-between gap-4"><dt class="text-muted">${label}</dt><dd class="text-right font-mono">${value}</dd></div>`
  return `
    <div class="w-60 font-sans text-asphalt">
      <div class="flex items-center justify-between border-b border-rule px-3 py-2">
        <span class="font-display text-sm font-extrabold">Route ${escapeHtml(route.id)} · mile ${Math.round(cp.mile)}</span>
        <span class="flex items-center gap-1.5 text-xs font-semibold">${chip}${escapeHtml(cp.risk.label)}</span>
      </div>
      <div class="space-y-1.5 px-3 py-2 text-xs">
        <div class="font-mono text-[0.8125rem] font-semibold">ETA ${formatClock(cp.eta)}</div>
        <dl class="space-y-0.5">
          ${row('Wind', `${formatReading('wind', w.wind_mph)}, gusts ${Math.round(w.gust_mph)}`)}
          ${row('Rain', formatReading('rain', w.rain_in_hr))}
          ${row('Snow', formatReading('snow', w.snow_in_hr))}
          ${row('Sky', describeWeather(w.weather_code))}
          ${w.temp_f === null ? '' : row('Temp', `${w.temp_f}°F`)}
        </dl>
        <p class="border-t border-rule pt-1.5 text-muted">${escapeHtml(riskReason(cp, loadLb))}</p>
      </div>
    </div>`
}
