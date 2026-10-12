import { memo } from 'react'
import { formatClock, formatDuration, formatMiles } from '../lib/format'
import { reasonText } from '../lib/reasons'
import type { RouteOption, TripPlan } from '../types'
import { RiskBar } from './RiskBar'
import { RoadList } from './RoadShield'

export const Recommendation = memo(function Recommendation({ plan }: { plan: TripPlan }) {
  const rec = plan.recommendation
  const route = plan.routes.find((r) => r.id === rec.route)!
  return (
    <section aria-labelledby="rec-title" className="rounded-lg bg-asphalt p-4 text-white">
      <p className="font-display text-2xs font-bold tracking-[0.12em] text-white/60 uppercase">Recommended</p>
      <h2 id="rec-title" className="mt-0.5 font-display text-2xl leading-tight font-extrabold">
        Take Route {route.id}
      </h2>
      <p className="mt-1 text-[0.8125rem] text-white/75">
        {formatMiles(route.distance_mi)} · {formatDuration(route.duration_s)} · arrives{' '}
        {formatClock(route.arrival_time)}
      </p>
      {rec.all_routes_blocked && (
        <p className="mt-3 flex gap-2 rounded-md bg-white/10 p-2 text-[0.8125rem] leading-snug">
          <span className="barricade mt-0.5 h-3 w-3 shrink-0 rounded-[2px]" aria-hidden />
          Every route crosses No Travel conditions at this departure time. Try a later departure.
        </p>
      )}
      {plan.routes.length === 1 && (
        <p className="mt-3 border-t border-white/15 pt-3 text-[0.8125rem] leading-snug text-white/90">
          Only one route was found between these places, so there is nothing to compare it with.
        </p>
      )}
      {rec.comparisons.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-white/15 pt-3 text-[0.8125rem] leading-snug text-white/90">
          {rec.comparisons.map((c) => (
            <li key={c.route} className="flex gap-2">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-white/60" aria-hidden />
              {reasonText(c)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
})

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-2xs text-muted">{label}</dt>
      <dd className={`font-mono text-[0.8125rem] font-semibold ${tone ?? ''}`}>{value}</dd>
    </div>
  )
}

const RouteCard = ({ route, selected, onSelect }: { route: RouteOption; selected: boolean; onSelect: () => void }) => {
  const m = route.exposure.miles
  const bad = m.no_travel + m.severe
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`w-full rounded-lg border bg-white p-3 text-left transition-[border-color,box-shadow] ${
        selected ? 'border-interstate shadow-[0_0_0_1px_var(--color-interstate)]' : 'border-rule hover:border-asphalt-soft/40'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`grid h-6 w-6 shrink-0 place-items-center rounded font-display text-sm font-extrabold ${
            selected ? 'bg-interstate text-white' : 'bg-asphalt text-white'
          }`}
        >
          {route.id}
        </span>
        <RoadList roads={route.roads} />
        {route.recommended && (
          <span className="ml-auto shrink-0 rounded-full bg-asphalt px-2 py-0.5 font-display text-2xs font-bold tracking-wide text-white uppercase">
            Best
          </span>
        )}
      </div>
      <p className="mt-2 font-mono text-[0.8125rem] text-asphalt">
        {formatMiles(route.distance_mi)} · {formatDuration(route.duration_s)}
        <span className="text-muted"> · arr {formatClock(route.arrival_time)}</span>
      </p>
      <RiskBar miles={m} className="mt-2 h-2" />
      <dl className="mt-2 grid grid-cols-3 gap-2">
        <Stat label="Severe+" value={formatMiles(bad)} tone={bad > 0 ? 'text-risk-severe' : undefined} />
        <Stat label="High" value={formatMiles(m.high)} tone={m.high > 0 ? 'text-risk-high' : undefined} />
        <Stat label="Avg risk" value={route.exposure.avg_risk.toFixed(2)} />
      </dl>
      {route.source === 'via-point' && (
        <p className="mt-2 text-2xs text-muted">Alternative built from a via point.</p>
      )}
    </button>
  )
}

export const RouteCards = memo(function RouteCards({
  routes,
  selectedId,
  onSelect,
}: {
  routes: RouteOption[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div role="radiogroup" aria-label="Route options" className="space-y-2">
      {routes.map((route) => (
        <RouteCard key={route.id} route={route} selected={route.id === selectedId} onSelect={() => onSelect(route.id)} />
      ))}
    </div>
  )
})
