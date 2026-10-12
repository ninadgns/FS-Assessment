import { useState } from 'react'
import { formatNumber, toLocalInputValue } from '../lib/format'
import type { TripFormValues } from '../lib/tripForm'
import type { SampleInterval } from '../types'
import { PlaceInput } from './PlaceInput'

const INTERVALS: SampleInterval[] = [10, 25, 50]
const WEEK_MS = 7 * 24 * 3600 * 1000
// Cargo, not gross: an 80,000 lb legal gross leaves roughly 45,000 lb for the load.
const MAX_LOAD_LB = 50_000

interface Props {
  values: TripFormValues
  onChange: (values: TripFormValues) => void
  onSubmit: (values: TripFormValues) => void
  submitting: boolean
  fieldErrors: Record<string, string>
}

export function TripForm({ values, onChange, onSubmit, submitting, fieldErrors }: Props) {
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({})
  const errors = { ...fieldErrors, ...localErrors }
  const set = <K extends keyof TripFormValues>(key: K, value: TripFormValues[K]) =>
    onChange({ ...values, [key]: value })

  // Bounds for the date picker, fixed when the form mounts.
  const [now] = useState(() => new Date())
  const maxDeparture = new Date(now.getTime() + WEEK_MS)

  const validate = (): boolean => {
    const next: Record<string, string> = {}
    if (!values.origin.label.trim()) next.origin = 'Enter a starting point.'
    if (!values.destination.label.trim()) next.destination = 'Enter a destination.'
    const load = Number(values.loadLb)
    if (!values.loadLb || !Number.isFinite(load) || load < 0 || load > MAX_LOAD_LB)
      next.load_weight_lb = `Enter a cargo weight between 0 and ${formatNumber(MAX_LOAD_LB)} lb.`
    if (!values.departure || Number.isNaN(Date.parse(values.departure)))
      next.departure_time = 'Choose a departure time.'
    setLocalErrors(next)
    return Object.keys(next).length === 0
  }

  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        if (validate()) onSubmit(values)
      }}
    >
      <PlaceInput
        marker="origin"
        label="From"
        placeholder="US or Canadian city, address or facility"
        value={values.origin}
        onChange={(origin) => set('origin', origin)}
        error={errors.origin}
      />
      <PlaceInput
        marker="destination"
        label="To"
        placeholder="US or Canadian city, address or facility"
        value={values.destination}
        onChange={(destination) => set('destination', destination)}
        error={errors.destination}
      />

      {/* Wraps onto two rows when large text would otherwise clip the departure time. */}
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[13rem] flex-[2_1_13rem]">
          <label htmlFor="departure" className="eyebrow mb-1 block">
            Departure
          </label>
          <input
            id="departure"
            type="datetime-local"
            className="field min-w-0 px-2.5 font-mono text-[0.8125rem]"
            value={values.departure}
            min={toLocalInputValue(now)}
            max={toLocalInputValue(maxDeparture)}
            onChange={(e) => set('departure', e.target.value)}
            aria-invalid={!!errors.departure_time}
          />
        </div>
        <div className="flex-[1_1_7.5rem]">
          <label htmlFor="load" className="eyebrow mb-1 block">
            Load weight
          </label>
          <div className="relative">
            <input
              id="load"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_LOAD_LB}
              step={1000}
              className="field pr-8 font-mono text-[0.8125rem]"
              value={values.loadLb}
              onChange={(e) => set('loadLb', e.target.value)}
              aria-invalid={!!errors.load_weight_lb}
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">
              lb
            </span>
          </div>
        </div>
      </div>
      {(errors.departure_time || errors.load_weight_lb) && (
        <p className="text-xs text-risk-severe">{errors.departure_time ?? errors.load_weight_lb}</p>
      )}

      <fieldset>
        <legend className="eyebrow mb-1">Check weather every</legend>
        <div className="grid grid-cols-3 rounded-md border border-rule bg-white p-0.5">
          {INTERVALS.map((mi) => (
            <label
              key={mi}
              className={`cursor-pointer rounded-[5px] py-1.5 text-center font-display text-sm font-bold transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-interstate ${
                values.interval === mi ? 'bg-asphalt text-white' : 'text-asphalt-soft hover:bg-concrete'
              }`}
            >
              <input
                type="radio"
                name="interval"
                className="sr-only"
                checked={values.interval === mi}
                onChange={() => set('interval', mi)}
              />
              {mi} mi
            </label>
          ))}
        </div>
      </fieldset>

      <button
        type="submit"
        disabled={submitting}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-interstate font-display text-[0.9375rem] font-extrabold tracking-wide text-white shadow-sm transition-colors hover:bg-interstate-deep disabled:cursor-wait disabled:opacity-80"
      >
        {submitting && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        )}
        {submitting ? 'Checking routes and forecasts…' : 'Plan routes'}
      </button>
      <p className="text-center text-2xs text-muted">
        High-wind limits tighten for loads over {formatNumber(30000)} and {formatNumber(40000)} lb.
      </p>
    </form>
  )
}
