import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatClock, formatDuration, formatHour, formatWeekday } from '../lib/format'
import { checkpointAt, truckPosition } from '../lib/geometry'
import { CONDITION_LABEL, formatReading, riskColor } from '../lib/risk'
import type { Checkpoint, RiskLevel, RouteOption, TripPlan } from '../types'
import { RiskDot } from './RiskBar'

export const HORIZON_H = 48
const PLAY_SPEED_H_PER_S = 4 // the full 48 h plays in 12 s
const pct = (h: number) => `${(Math.min(Math.max(h, 0), HORIZON_H) / HORIZON_H) * 100}%`

interface Band {
  from: number // hours after departure
  to: number
  level: RiskLevel
}

/** A route's risk over driving time: each checkpoint owns the time halfway to its neighbours. */
function bands(route: RouteOption): Band[] {
  const cps = route.checkpoints
  const hours = cps.map((c) => c.elapsed_s / 3600)
  const out: Band[] = []
  cps.forEach((cp, i) => {
    const from = i === 0 ? 0 : (hours[i - 1] + hours[i]) / 2
    const to = i === cps.length - 1 ? route.duration_s / 3600 : (hours[i] + hours[i + 1]) / 2
    const last = out.at(-1)
    if (last && last.level === cp.risk.level) last.to = to
    else out.push({ from, to, level: cp.risk.level })
  })
  return out
}

/** "Severe, rain 0.62 in/hr": the level plus the condition that set it. */
function readout(cp: Checkpoint): string {
  const driver = cp.risk.factors.find((f) => f.condition === cp.risk.drivers[0])
  if (!driver) return `${cp.risk.label}, wind ${formatReading('wind', cp.weather.wind_mph)}`
  return `${cp.risk.label}, ${CONDITION_LABEL[driver.condition].toLowerCase()} ${formatReading(driver.condition, driver.value)}`
}

interface Tick {
  h: number // hours after departure
  label: string
  day: string | null
}

/** Ticks on whole local clock hours (every `step` h), so labels read true times. */
function timeTicks(departureMs: number, step: number): Tick[] {
  const t = new Date(departureMs)
  t.setMinutes(0, 0, 0)
  do t.setHours(t.getHours() + 1)
  while (t.getHours() % step !== 0)
  const out: Tick[] = []
  for (; t.getTime() <= departureMs + HORIZON_H * 3600_000; t.setHours(t.getHours() + step)) {
    out.push({
      h: (t.getTime() - departureMs) / 3600_000,
      label: formatHour(t),
      day: out.length === 0 || t.getHours() === 0 ? formatWeekday(t) : null,
    })
  }
  return out
}

/** Static parts of the dock, memoized so scrubbing only re-renders the cursor. */
const RouteBandRows = memo(function RouteBandRows({
  routeBands,
  selectedRouteId,
}: {
  routeBands: { route: RouteOption; bands: Band[] }[]
  selectedRouteId: string
}) {
  return (
    <div className="flex flex-col gap-1 [contain:paint]">
      {routeBands.map(({ route, bands: rb }) => {
        const isSelected = route.id === selectedRouteId
        return (
          <div key={route.id} className="relative h-4 overflow-hidden rounded-[3px] bg-concrete">
            {rb.map((b) => (
              <span
                key={`${b.from}-${b.level}`}
                className={`absolute inset-y-0 ${b.level === 4 ? 'barricade' : ''}`}
                style={{
                  left: pct(b.from),
                  width: `calc(${pct(b.to)} - ${pct(b.from)})`,
                  background: b.level === 4 ? undefined : riskColor(b.level),
                  opacity: isSelected ? 1 : 0.55,
                }}
              />
            ))}
            {route.duration_s / 3600 < HORIZON_H && (
              <span
                className="absolute inset-y-0 w-0.5 bg-asphalt"
                style={{ left: pct(route.duration_s / 3600) }}
                title={`Arrives ${formatClock(route.arrival_time)}`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
})

const TimeAxis = memo(function TimeAxis({ ticks }: { ticks: Tick[] }) {
  return (
    <div className="relative mt-1 h-7 border-t border-rule">
      {ticks.map((t) => (
        <span
          key={t.h}
          className={`absolute top-0 flex flex-col items-center ${
            t.h < 2 ? '' : t.h > HORIZON_H - 2 ? '-translate-x-full' : '-translate-x-1/2'
          }`}
          style={{ left: pct(t.h) }}
        >
          <span className="h-1.5 w-px bg-asphalt-soft/50" />
          <span className="font-mono text-2xs leading-tight whitespace-nowrap text-muted">
            {t.day && <span className="font-semibold text-asphalt">{t.day} </span>}
            {t.label}
          </span>
        </span>
      ))}
    </div>
  )
})

interface Props {
  plan: TripPlan
  selectedRouteId: string
  hours: number
  onHoursChange: (hours: number) => void
  onSelectRoute: (id: string) => void
}

export function TimelineDock({ plan, selectedRouteId, hours, onHoursChange, onSelectRoute }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const departureMs = Date.parse(plan.request.departure_time)
  // Playback reads the current position without restarting its animation loop.
  const hoursRef = useRef(hours)
  useLayoutEffect(() => {
    hoursRef.current = hours
  }, [hours])

  const routeBands = useMemo(() => plan.routes.map((r) => ({ route: r, bands: bands(r) })), [plan])

  // Tick spacing follows the track width so labels never collide on phones.
  const [trackWidth, setTrackWidth] = useState(800)
  useEffect(() => {
    const node = trackRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setTrackWidth(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const tickStep = trackWidth < 560 ? 12 : 6

  const ticks = useMemo(() => timeTicks(departureMs, tickStep), [departureMs, tickStep])

  // Playback: advance the cursor with requestAnimationFrame, stop at the horizon. The
  // position is tracked locally so a slow render can't make playback stall or skip back.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    let last = performance.now()
    let position = hoursRef.current
    const step = (now: number) => {
      position += ((now - last) / 1000) * PLAY_SPEED_H_PER_S
      last = now
      if (position >= HORIZON_H) {
        onHoursChange(HORIZON_H)
        setPlaying(false)
        return
      }
      onHoursChange(position)
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [playing, onHoursChange])

  const hoursAtPointer = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width)
    return (x / rect.width) * HORIZON_H
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    setPlaying(false)
    onHoursChange(hoursAtPointer(e.clientX))
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) onHoursChange(hoursAtPointer(e.clientX))
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const steps: Record<string, number> = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 6,
      PageDown: -6,
    }
    let next: number | null = null
    if (e.key in steps) next = Math.round(hours) + steps[e.key]
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = HORIZON_H
    if (next === null) return
    e.preventDefault()
    setPlaying(false)
    onHoursChange(Math.min(Math.max(next, 0), HORIZON_H))
  }

  const cursorTime = departureMs + hours * 3600_000
  const selected = plan.routes.find((r) => r.id === selectedRouteId)!
  const pos = truckPosition(selected, hours * 3600)
  const here = checkpointAt(selected, hours * 3600)

  return (
    <section aria-label="Forecast timeline" className="border-t border-rule bg-paper px-3 pt-2 pb-3 sm:px-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={() => {
            if (!playing && hours >= HORIZON_H - 0.01) onHoursChange(0)
            setPlaying((p) => !p)
          }}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-asphalt text-white hover:bg-asphalt-soft"
          aria-label={playing ? 'Pause forecast playback' : 'Play forecast'}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
              <path fill="currentColor" d="M4 3h3v10H4zM9 3h3v10H9z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
              <path fill="currentColor" d="M4.5 2.5v11l9-5.5z" />
            </svg>
          )}
        </button>
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold">
            {formatClock(cursorTime)}
            <span className="ml-2 text-muted">+{formatDuration(hours * 3600)}</span>
          </p>
        </div>
        {/* Not a live region: it changes every frame while scrubbing. The slider's
            aria-valuetext carries the time for screen readers. */}
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-asphalt-soft">
          <span className="font-display font-bold text-asphalt">Route {selected.id}</span>
          {pos.arrived ? (
            <span>arrived {formatClock(selected.arrival_time)}</span>
          ) : (
            <>
              <span className="font-mono">mile {Math.round(pos.mile)}</span>
              <span aria-hidden>·</span>
              <RiskDot level={here.risk.level} />
              <span>{readout(here)}</span>
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-[1.5rem_1fr] gap-x-2">
        {/* Route rows */}
        <div className="flex flex-col gap-1">
          {routeBands.map(({ route }) => (
            <button
              key={route.id}
              type="button"
              onClick={() => onSelectRoute(route.id)}
              aria-label={`Select route ${route.id}`}
              className={`grid h-4 place-items-center rounded-[3px] font-display text-2xs font-extrabold ${
                route.id === selectedRouteId ? 'bg-interstate text-white' : 'bg-rule text-asphalt-soft hover:bg-asphalt-soft/30'
              }`}
            >
              {route.id}
            </button>
          ))}
        </div>

        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Forecast time"
          aria-valuemin={0}
          aria-valuemax={HORIZON_H}
          aria-valuenow={Math.round(hours * 10) / 10}
          aria-valuetext={`${formatClock(cursorTime)}, ${Math.round(hours)} ${Math.round(hours) === 1 ? 'hour' : 'hours'} after departure`}
          className="group relative cursor-ew-resize touch-none rounded-sm outline-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onKeyDown={onKeyDown}
        >
          <RouteBandRows routeBands={routeBands} selectedRouteId={selectedRouteId} />
          <TimeAxis ticks={ticks} />

          {/* Cursor */}
          {/* Moved with a transform on its own layer, so scrubbing never repaints the
              band rows underneath (hundreds of strips when risk flips often). */}
          <div
            className="pointer-events-none absolute -top-1 bottom-6 left-0 w-0 will-change-transform"
            style={{ transform: `translateX(${(Math.min(Math.max(hours, 0), HORIZON_H) / HORIZON_H) * trackWidth}px)` }}
          >
            <div className="absolute inset-y-0 -left-px w-0.5 bg-asphalt group-focus-visible:bg-interstate" />
            <div className="absolute -top-1 -left-[7px] h-3.5 w-3.5 rounded-full border-2 border-white bg-asphalt shadow group-focus-visible:bg-interstate" />
          </div>
        </div>
      </div>
    </section>
  )
}
