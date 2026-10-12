import { RISK } from '../lib/risk'
import type { RiskKey } from '../types'

/** Share of the route's miles at each risk level, worst levels drawn last. */
export function RiskBar({ miles, className = 'h-2' }: { miles: Record<RiskKey, number>; className?: string }) {
  const total = RISK.reduce((sum, r) => sum + miles[r.key], 0) || 1
  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-rule ${className}`} aria-hidden>
      {RISK.map((r) =>
        miles[r.key] > 0 ? (
          <span
            key={r.key}
            className={r.level === 4 ? 'barricade' : ''}
            style={{
              width: `${(miles[r.key] / total) * 100}%`,
              background: r.level === 4 ? undefined : r.color,
            }}
          />
        ) : null,
      )}
    </div>
  )
}

export function RiskDot({ level, className = 'h-2.5 w-2.5' }: { level: number; className?: string }) {
  const r = RISK[level]
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 ${level === 4 ? 'barricade rounded-[2px]' : 'rounded-full'} ${className}`}
      style={level === 4 ? undefined : { background: r.color }}
    />
  )
}
