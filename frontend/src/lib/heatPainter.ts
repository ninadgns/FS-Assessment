import type { Heatmap, HeatLayer } from '../types'
import { buildLut, HEAT_SCALES, lutOffset } from './heatScales'

const luts = new Map<HeatLayer, Uint8ClampedArray>()

function lutFor(layer: HeatLayer) {
  let lut = luts.get(layer)
  if (!lut) {
    lut = buildLut(HEAT_SCALES[layer])
    luts.set(layer, lut)
  }
  return lut
}

/**
 * Paints the corridor grid at an arbitrary moment into `image` (one pixel per cell).
 * Values are interpolated between the two surrounding forecast frames, so the slider
 * moves smoothly instead of jumping hour to hour; the GPU then smooths between cells.
 *
 * Instantaneous values (wind) sit at their timestamp. Hourly totals (rain, snow and the
 * risk built from them) cover the hour *before* their timestamp, so they are placed at
 * that hour's midpoint: the heatmap then matches checkpoint classification to within
 * half an hour instead of lagging by up to a full hour.
 */
export function paintHeatmap(image: ImageData, heatmap: Heatmap, layer: HeatLayer, epochS: number) {
  const { times, cols, rows, opacity, nx } = heatmap
  const frames = heatmap.layers[layer]
  const scale = HEAT_SCALES[layer]
  const lut = lutFor(layer)
  const f = (epochS - times[0]) / 3600 + (scale.hourlyTotal ? 0.5 : 0)
  const i0 = Math.min(Math.max(Math.floor(f), 0), times.length - 2)
  const t = Math.min(Math.max(f - i0, 0), 1)
  const a = frames[i0]
  const b = frames[i0 + 1]
  const data = image.data
  data.fill(0)
  for (let k = 0; k < cols.length; k++) {
    const value = a[k] + (b[k] - a[k]) * t
    const o = lutOffset(scale, value)
    const p = (rows[k] * nx + cols[k]) * 4
    data[p] = lut[o]
    data[p + 1] = lut[o + 1]
    data[p + 2] = lut[o + 2]
    data[p + 3] = lut[o + 3] * opacity[k]
  }
}
