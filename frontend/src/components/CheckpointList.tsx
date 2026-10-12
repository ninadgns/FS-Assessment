import { memo } from 'react'
import { formatClock } from '../lib/format'
import type { CheckpointRef, RouteOption } from '../types'
import { readingsLine } from '../lib/risk'
import { RiskDot } from './RiskBar'

interface Props {
  route: RouteOption
  interval: number
  hovered: CheckpointRef | null
  onHover: (ref: CheckpointRef | null) => void
  onPick: (elapsedS: number) => void
}

/** The selected route's checkpoints, read like mile posts down the road. */
export const CheckpointList = memo(function CheckpointList({ route, interval, hovered, onHover, onPick }: Props) {
  return (
    <section aria-labelledby="cp-title">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 id="cp-title" className="eyebrow">
          Route {route.id} checkpoints
        </h3>
        <span className="text-2xs text-muted">every {interval} mi</span>
      </div>
      <ol className="divide-y divide-rule overflow-hidden rounded-lg border border-rule bg-white" onMouseLeave={() => onHover(null)}>
        {route.checkpoints.map((cp) => {
          const active = hovered?.routeId === route.id && hovered.index === cp.index
          return (
            <li key={cp.index}>
              <button
                type="button"
                className={`grid w-full grid-cols-[2.6rem_1fr_auto] items-center gap-3 px-2.5 py-1.5 text-left transition-colors ${
                  active ? 'bg-interstate/8' : 'hover:bg-concrete/60'
                }`}
                onMouseEnter={() => onHover({ routeId: route.id, index: cp.index })}
                onFocus={() => onHover({ routeId: route.id, index: cp.index })}
                onBlur={() => onHover(null)}
                onClick={() => onPick(cp.elapsed_s)}
                aria-label={`Mile ${Math.round(cp.mile)}, ${formatClock(cp.eta)}, ${cp.risk.label} risk. Show on timeline.`}
              >
                {/* Mile post: a narrow sign with the mileage stacked on it. */}
                <span className="flex flex-col items-center rounded-[3px] bg-asphalt py-0.5 text-white">
                  <span className="text-[0.5rem] leading-none font-bold tracking-wider text-white/60">MILE</span>
                  <span className="font-display text-[0.8125rem] leading-tight font-extrabold">{Math.round(cp.mile)}</span>
                </span>
                <span className="min-w-0">
                  <span className="block font-mono text-xs font-semibold">{formatClock(cp.eta)}</span>
                  <span className="block truncate font-mono text-2xs text-muted" title={readingsLine(cp)}>
                    {readingsLine(cp)}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-xs font-semibold">
                  <RiskDot level={cp.risk.level} />
                  {cp.risk.label}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
})
