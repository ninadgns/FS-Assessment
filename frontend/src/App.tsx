import { useMutation, useQueryClient } from '@tanstack/react-query'
import { lazy, memo, Suspense, useCallback, useState } from 'react'
import { ApiError, planTrip } from './api'
import { CheckpointList } from './components/CheckpointList'
import { HeatControls } from './components/HeatControls'
import { MapView } from './components/MapView'
import { Recommendation, RouteCards } from './components/Results'
import { HORIZON_H, TimelineDock } from './components/TimelineDock'
import { TripForm } from './components/TripForm'
import { formatClock, formatPounds, nowInputValue, timeZoneName } from './lib/format'
import { defaultFormValues, freshDeparture, toPlanRequest, type TripFormValues } from './lib/tripForm'
import type { CheckpointRef, HeatLayer, SampleInterval, TripPlan } from './types'

const EXAMPLES: { origin: [string, number, number]; destination: [string, number, number] }[] = [
  { origin: ['Chicago, IL', 41.8781, -87.6298], destination: ['Denver, CO', 39.7392, -104.9903] },
  { origin: ['Salt Lake City, UT', 40.7608, -111.891], destination: ['Seattle, WA', 47.6062, -122.3321] },
  { origin: ['New Orleans, LA', 29.9511, -90.0715], destination: ['Jacksonville, FL', 30.3322, -81.6557] },
]

// Stress-test data switch (dev, or VITE_TEST_DATA=true builds); dropped from production.
const DataModeToggle =
  import.meta.env.DEV || import.meta.env.VITE_TEST_DATA === 'true'
    ? lazy(() => import('./dev/DataModeToggle').then((m) => ({ default: m.DataModeToggle })))
    : null

const PROVIDER_NAME: Record<string, string> = { tomtom: 'TomTom truck routing', osrm: 'OSRM' }

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
        <path d="M4 3h24v14c0 7-6 11.5-12 13C10 28.5 4 24 4 17z" fill="#1747A6" />
        <path d="M4 3h24v6H4z" fill="#D62839" />
        <path d="M11 23l5-11 5 11" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div>
        <h1 className="font-display text-lg leading-none font-extrabold tracking-tight">Clearway</h1>
        <p className="text-2xs text-muted">Weather-aware truck routing</p>
      </div>
    </div>
  )
}

const TripSummary = memo(function TripSummary({
  values,
  plan,
  busy,
  onEdit,
  onIntervalChange,
}: {
  values: TripFormValues
  plan: TripPlan
  busy: boolean
  onEdit: () => void
  onIntervalChange: (mi: SampleInterval) => void
}) {
  const { request } = plan
  // While a re-plan runs, show the interval being requested; otherwise the plan's own.
  const activeInterval = busy ? values.interval : request.sample_interval_mi
  return (
    <section aria-label="Trip" className="space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Place names identify the trip, so they wrap (two lines max) instead of truncating. */}
          <p className="flex items-start gap-1.5 font-display text-[0.9375rem] leading-snug font-extrabold">
            <span className="mt-[0.3em] h-2.5 w-2.5 shrink-0 rounded-full border-2 border-asphalt" aria-hidden />
            <span className="line-clamp-2 [overflow-wrap:anywhere]" title={request.origin.label}>
              {request.origin.label}
            </span>
          </p>
          <p className="mt-0.5 flex items-start gap-1.5 font-display text-[0.9375rem] leading-snug font-extrabold">
            <span className="mt-[0.3em] h-2.5 w-2.5 shrink-0 rounded-[2px] bg-asphalt" aria-hidden />
            <span className="line-clamp-2 [overflow-wrap:anywhere]" title={request.destination.label}>
              {request.destination.label}
            </span>
          </p>
          <p className="mt-1 font-mono text-xs text-muted">
            Departs {formatClock(request.departure_time)} · {formatPounds(request.load_weight_lb)}
          </p>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="shrink-0 rounded-md border border-rule bg-white px-2.5 py-1 font-display text-xs font-bold hover:border-asphalt-soft/50"
        >
          Edit trip
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span className="eyebrow shrink-0">Check every</span>
        <div className="grid flex-1 grid-cols-3 rounded-md border border-rule bg-white p-0.5" role="radiogroup" aria-label="Checkpoint interval">
          {([10, 25, 50] as SampleInterval[]).map((mi) => (
            <button
              key={mi}
              type="button"
              role="radio"
              aria-checked={activeInterval === mi}
              disabled={busy}
              onClick={() => mi !== activeInterval && onIntervalChange(mi)}
              className={`rounded-[5px] py-1 font-display text-xs font-bold transition-colors disabled:cursor-wait ${
                activeInterval === mi ? 'bg-asphalt text-white' : 'text-asphalt-soft hover:bg-concrete'
              }`}
            >
              {mi} mi
            </button>
          ))}
        </div>
      </div>
    </section>
  )
})

export default function App() {
  const [form, setForm] = useState<TripFormValues>(defaultFormValues)
  const [editing, setEditing] = useState(true)
  const [plan, setPlan] = useState<TripPlan | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<CheckpointRef | null>(null)
  const [hours, setHours] = useState(0)
  const [heatLayer, setHeatLayer] = useState<HeatLayer>('risk')
  const [heatVisible, setHeatVisible] = useState(true)

  const mutation = useMutation({
    mutationFn: planTrip,
    onSuccess: (result) => {
      setPlan(result)
      setSelected(result.recommendation.route)
      setHovered(null)
      setHours(0)
      setEditing(false)
    },
  })

  const { mutate } = mutation
  const submit = useCallback(
    (values: TripFormValues) => {
      // A departure left at "now" while the page sat open would be rejected as past.
      const fresh = { ...values, departure: freshDeparture(values.departure) }
      setForm(fresh)
      mutate(toPlanRequest(fresh))
    },
    [mutate],
  )
  const editTrip = useCallback(() => setEditing(true), [])
  const changeInterval = useCallback(
    (interval: SampleInterval) => submit({ ...form, interval }),
    [form, submit],
  )

  const runExample = (example: (typeof EXAMPLES)[number]) => {
    const [oLabel, oLat, oLon] = example.origin
    const [dLabel, dLat, dLon] = example.destination
    submit({
      ...form,
      origin: { label: oLabel, lat: oLat, lon: oLon },
      destination: { label: dLabel, lat: dLat, lon: dLon },
      departure: nowInputValue(),
    })
  }

  const queryClient = useQueryClient()
  const pickCheckpoint = useCallback((elapsedS: number) => setHours(Math.min(elapsedS / 3600, HORIZON_H)), [])
  const error = mutation.error instanceof ApiError ? mutation.error : null
  // A re-plan failed: the results on screen belong to the previous request.
  const stale = mutation.isError && plan !== null
  const selectedRoute = plan?.routes.find((r) => r.id === selected) ?? null

  return (
    // Phones stack header, then the map once there is a plan (the form first before that).
    // Desktop pins the sidebar left and the map right via explicit grid placement.
    <div className="flex min-h-full flex-col lg:grid lg:h-full lg:grid-cols-[400px_1fr] lg:grid-rows-[auto_1fr]">
      <header className="flex items-center justify-between border-b border-rule bg-paper px-4 py-3 lg:col-start-1 lg:row-start-1 lg:border-r">
        <Brand />
        {plan && (
          <span className="text-right text-2xs leading-tight text-muted">Times in {timeZoneName()}</span>
        )}
      </header>

      <aside
        className={`border-rule bg-paper lg:col-start-1 lg:row-start-2 lg:min-h-0 lg:overflow-y-auto lg:border-r ${
          plan ? 'order-3' : 'order-1'
        }`}
      >
        <div className="space-y-4 px-4 py-4">
          {error && !error.fields.origin && !error.fields.destination && (
            <div role="alert" className="rounded-md border border-risk-severe/30 bg-risk-severe/5 p-3 text-[0.8125rem] text-asphalt">
              {error.message}
            </div>
          )}

          {editing || !plan ? (
            <>
              <TripForm
                values={form}
                onChange={setForm}
                onSubmit={submit}
                submitting={mutation.isPending}
                fieldErrors={error?.fields ?? {}}
              />
              {plan && (
                <button type="button" onClick={() => setEditing(false)} className="w-full text-center text-xs font-semibold text-interstate hover:underline">
                  Back to current results
                </button>
              )}
            </>
          ) : (
            <TripSummary
              values={form}
              plan={plan}
              busy={mutation.isPending}
              onEdit={editTrip}
              onIntervalChange={changeInterval}
            />
          )}

          {!plan && (
            <section className="space-y-3 border-t border-rule pt-4">
              <div>
                <h2 className="eyebrow mb-2">Try a trip</h2>
                <div className="flex flex-wrap gap-1.5">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex.origin[0]}
                      type="button"
                      disabled={mutation.isPending}
                      onClick={() => runExample(ex)}
                      className="rounded-full border border-rule bg-white px-3 py-1 text-xs font-medium hover:border-interstate hover:text-interstate disabled:opacity-50"
                    >
                      {ex.origin[0].split(',')[0]} → {ex.destination[0].split(',')[0]}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[0.8125rem] leading-relaxed text-asphalt-soft">
                Clearway finds three routes, checks the forecast at each checkpoint for the hour your
                truck gets there, and recommends the one with the least Severe and High-risk driving,
                then the fastest.
              </p>
            </section>
          )}

          {plan && selectedRoute && (
            <div className={`space-y-4 transition-opacity ${mutation.isPending || stale ? 'opacity-50' : ''}`}>
              {stale && (
                <p className="font-display text-xs font-bold text-asphalt-soft">
                  Showing your previous plan. Change the trip and plan again.
                </p>
              )}
              {plan.warnings.map((w) => (
                <p key={w} role="status" className="rounded-md border border-risk-moderate/50 bg-risk-moderate/10 p-3 text-[0.8125rem]">
                  {w}
                </p>
              ))}
              <Recommendation plan={plan} />
              <section aria-labelledby="routes-title">
                <h3 id="routes-title" className="eyebrow mb-2">
                  Routes, fastest first
                </h3>
                <RouteCards routes={plan.routes} selectedId={selected} onSelect={setSelected} />
              </section>
              <CheckpointList
                route={selectedRoute}
                interval={plan.request.sample_interval_mi}
                hovered={hovered}
                onHover={setHovered}
                onPick={pickCheckpoint}
              />
              <p className="text-2xs leading-relaxed text-muted">
                Routing: {PROVIDER_NAME[plan.provider] ?? plan.provider}. Forecasts: Open-Meteo, sampled at
                each checkpoint&rsquo;s ETA. ETAs assume continuous driving.
              </p>
            </div>
          )}
        </div>
      </aside>

      <main
        className={`relative flex flex-col lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-0 ${
          plan ? 'order-2' : 'order-2 border-t border-rule'
        }`}
      >
        <div className="relative h-[58vh] min-h-[320px] lg:h-auto lg:flex-1">
          <MapView
            plan={plan}
            selectedRouteId={selected}
            hoveredCheckpoint={hovered}
            hours={hours}
            heatLayer={heatLayer}
            heatVisible={heatVisible}
            onSelectRoute={setSelected}
            onHoverCheckpoint={setHovered}
          />
          {plan?.heatmap && (
            <div className="pointer-events-none absolute top-3 right-3">
              <HeatControls
                layer={heatLayer}
                visible={heatVisible}
                cellKm={plan.heatmap.cell_km}
                onLayerChange={setHeatLayer}
                onVisibleChange={setHeatVisible}
              />
            </div>
          )}
          {mutation.isPending && (
            <div className="pointer-events-none absolute inset-x-0 top-0">
              <div className="h-1 overflow-hidden bg-interstate/15">
                <div className="h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] bg-interstate" />
              </div>
              <p className="mx-auto mt-3 w-fit rounded-full bg-asphalt px-4 py-1.5 text-xs font-medium text-white shadow-lg">
                Finding routes and sampling the forecast along each one…
              </p>
            </div>
          )}
        </div>
        {plan && selected && (
          <TimelineDock
            plan={plan}
            selectedRouteId={selected}
            hours={hours}
            onHoursChange={setHours}
            onSelectRoute={setSelected}
          />
        )}
      </main>
      {DataModeToggle && (
        <Suspense>
          <DataModeToggle
            onChange={() => {
              queryClient.removeQueries({ queryKey: ['geocode'] })
              if (plan) submit(form)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
