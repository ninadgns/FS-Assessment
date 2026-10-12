const clock = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
})
const hourOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const number = new Intl.NumberFormat()

/** Keeps a formatted value on one line ("50,000 lb", "Mon 11:06 PM") when text wraps. */
const nowrap = (s: string) => s.replace(/\s/g, '\u00a0')

/** "Sat 2:45 PM" in the viewer's time zone. */
export const formatClock = (when: string | number | Date) => nowrap(clock.format(new Date(when)))
export const formatHour = (when: number | Date) => hourOnly.format(new Date(when))
export const formatWeekday = (when: number | Date) => weekday.format(new Date(when))

let zoneName: string | undefined

/** Short name of the viewer's time zone, computed once (it renders on every frame). */
export function timeZoneName(): string {
  zoneName ??=
    new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value ?? 'local time'
  return zoneName
}

/** "17 h 48 m", "52 m". */
export function formatDuration(seconds: number): string {
  const total = Math.round(Math.abs(seconds) / 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return nowrap(`${m} m`)
  return nowrap(m === 0 ? `${h} h` : `${h} h ${m} m`)
}

export const formatMiles = (miles: number, digits = 0) =>
  nowrap(`${number.format(Number(miles.toFixed(digits)))} mi`)

export const formatNumber = (n: number) => number.format(n)

/** "50,000 lb", unbreakable. */
export const formatPounds = (lb: number) => nowrap(`${number.format(lb)} lb`)

export const nowInputValue = () => toLocalInputValue(new Date())

/** Value for <input type="datetime-local"> in the viewer's time zone. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

// WMO weather interpretation codes, as used by Open-Meteo.
const WMO: Record<number, string> = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Violent rain showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm, hail',
  99: 'Thunderstorm, hail',
}

export const describeWeather = (code: number | null) =>
  code === null ? 'No data' : (WMO[code] ?? 'Unknown')
