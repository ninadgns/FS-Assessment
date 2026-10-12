import { memo, useMemo, useState } from 'react'
import { HEAT_SCALES, legendGradient } from '../lib/heatScales'
import { RISK } from '../lib/risk'
import type { HeatLayer } from '../types'
import { RiskDot } from './RiskBar'

const LAYERS: HeatLayer[] = ['risk', 'wind', 'rain', 'snow']

interface Props {
  layer: HeatLayer
  visible: boolean
  cellKm: number | null
  onLayerChange: (layer: HeatLayer) => void
  onVisibleChange: (visible: boolean) => void
}

export const HeatControls = memo(function HeatControls({
  layer,
  visible,
  cellKm,
  onLayerChange,
  onVisibleChange,
}: Props) {
  const scale = HEAT_SCALES[layer]
  const gradient = useMemo(() => legendGradient(scale), [scale])
  // Starts folded on phones, where the panel would cover most of the map.
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 640px)').matches)
  return (
    <div className="pointer-events-auto w-56 rounded-lg border border-rule bg-white/95 p-3 shadow-md backdrop-blur-sm sm:w-64">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="eyebrow flex items-center gap-1 hover:text-asphalt"
          aria-expanded={open}
          aria-controls="heat-controls-body"
          onClick={() => setOpen((o) => !o)}
        >
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden className={`transition-transform ${open ? 'rotate-90' : ''}`}>
            <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
          Heatmap · {scale.label}
        </button>
        <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-muted">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-interstate"
            checked={visible}
            onChange={(e) => onVisibleChange(e.target.checked)}
          />
          Show
        </label>
      </div>
      <div id="heat-controls-body" hidden={!open}>
      <div role="radiogroup" aria-label="Heatmap layer" className="mt-2 grid grid-cols-4 rounded-md bg-concrete p-0.5">
        {LAYERS.map((l) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={layer === l}
            onClick={() => {
              onLayerChange(l)
              onVisibleChange(true)
            }}
            className={`rounded-[5px] py-1 font-display text-xs font-bold transition-colors ${
              layer === l ? 'bg-white text-asphalt shadow-sm' : 'text-muted hover:text-asphalt'
            }`}
          >
            {HEAT_SCALES[l].label}
          </button>
        ))}
      </div>

      <div className={`mt-3 transition-opacity ${visible ? '' : 'opacity-40'}`}>
        {layer === 'risk' ? (
          <ul className="grid grid-cols-5 gap-1">
            {RISK.map((r) => (
              <li key={r.key} className="flex flex-col items-center gap-1 text-center">
                <RiskDot level={r.level} className="h-2.5 w-full !rounded-sm" />
                <span className="text-[0.625rem] leading-none text-asphalt-soft">{r.label}</span>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <div className="h-2.5 rounded-sm" style={{ background: gradient }} />
            <div className="relative mt-1 h-3">
              {scale.ticks.map((t) => (
                <span
                  key={t.at}
                  className="absolute -translate-x-1/2 font-mono text-[0.625rem] leading-none text-asphalt-soft"
                  style={{ left: `${(t.at / scale.max) * 100}%` }}
                >
                  {t.label}
                </span>
              ))}
            </div>
            <p className="mt-0.5 text-right text-[0.625rem] text-muted">{scale.unit}, ticks at risk thresholds</p>
          </>
        )}
      </div>
      <p className="mt-2 border-t border-rule pt-2 text-[0.625rem] leading-snug text-muted">
        {layer === 'risk' ? 'Risk for your load, ' : ''}
        {cellKm ? `on a ~${Math.round(cellKm)} km grid. ` : ''}
        Route lines always show checkpoint risk.
      </p>
      </div>
    </div>
  )
})
