import type { PlaceInput, PlanRequest, SampleInterval } from '../types'
import { nowInputValue } from './format'

export interface TripFormValues {
  origin: PlaceInput
  destination: PlaceInput
  departure: string // datetime-local value, viewer's time zone
  loadLb: string
  interval: SampleInterval
}

export const defaultFormValues = (): TripFormValues => ({
  origin: { label: '' },
  destination: { label: '' },
  departure: nowInputValue(),
  loadLb: '42000',
  interval: 25,
})

export function toPlanRequest(v: TripFormValues): PlanRequest {
  return {
    origin: v.origin,
    destination: v.destination,
    departure_time: new Date(v.departure).toISOString(),
    load_weight_lb: Number(v.loadLb),
    sample_interval_mi: v.interval,
  }
}

/** Keeps a departure that has slipped into the past (e.g. "now" an hour ago) valid. */
export const freshDeparture = (departure: string) =>
  Date.parse(departure) < Date.now() ? nowInputValue() : departure
