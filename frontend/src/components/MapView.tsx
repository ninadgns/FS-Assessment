import {
  type CanvasSource,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  Map as MapLibreMap,
  type StyleSpecification,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from 'maplibre-gl'
// MapLibre 6 needs its worker URL set explicitly under a bundler (Vite bundles it here).
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatDuration } from '../lib/format'
import { boundsOf, labelAnchor, riskStretches, truckPosition } from '../lib/geometry'
import { paintHeatmap } from '../lib/heatPainter'
import { checkpointPopupHtml } from '../lib/popup'
import { RISK } from '../lib/risk'
import type { CheckpointRef, HeatLayer, RouteOption, TripPlan } from '../types'

setWorkerUrl(workerUrl)

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'
// Used when the basemap style can't be fetched, so routes still draw on something.
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9ebe6' } }],
}
const RISK_COLOR_EXPR = [
  'match',
  ['get', 'level'],
  ...RISK.flatMap((r) => [r.level, r.color]),
  '#888',
] as unknown as string

/** The basemap style, retrying network failures and 5xx with a growing pause. */
async function fetchStyle(attempts = 3): Promise<StyleSpecification> {
  let lastError: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await fetch(STYLE_URL)
      if (response.ok) return (await response.json()) as StyleSpecification
      lastError = new Error(`basemap style: HTTP ${response.status}`)
      if (response.status < 500) break // a client error won't fix itself
    } catch (err) {
      lastError = err // offline or DNS failure: worth another try
    }
    if (i < attempts) await new Promise((resolve) => setTimeout(resolve, 1500 * i))
  }
  throw lastError
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

interface Props {
  plan: TripPlan | null
  selectedRouteId: string | null
  hoveredCheckpoint: CheckpointRef | null
  hours: number
  heatLayer: HeatLayer
  heatVisible: boolean
  onSelectRoute: (id: string) => void
  onHoverCheckpoint: (ref: CheckpointRef | null) => void
}

const checkpointFeatureId = (routeIdx: number, index: number) => routeIdx * 100_000 + index

function routeFeatures(routes: RouteOption[], selectedId: string | null) {
  return {
    type: 'FeatureCollection' as const,
    features: routes.flatMap((route) =>
      riskStretches(route).map((s) => ({
        type: 'Feature' as const,
        properties: { routeId: route.id, level: s.level, selected: route.id === selectedId ? 1 : 0 },
        geometry: { type: 'LineString' as const, coordinates: s.coords },
      })),
    ),
  }
}

function checkpointFeatures(routes: RouteOption[], selectedId: string | null) {
  return {
    type: 'FeatureCollection' as const,
    features: routes.flatMap((route, r) =>
      route.checkpoints.map((cp) => ({
        type: 'Feature' as const,
        id: checkpointFeatureId(r, cp.index),
        properties: {
          routeId: route.id,
          index: cp.index,
          level: cp.risk.level,
          selected: route.id === selectedId ? 1 : 0,
        },
        geometry: { type: 'Point' as const, coordinates: [cp.lon, cp.lat] },
      })),
    ),
  }
}

function el(className: string, html = ''): HTMLElement {
  const node = document.createElement('div')
  node.className = className
  node.innerHTML = html
  return node
}

interface RouteLabel {
  id: string
  marker: Marker
  button: HTMLButtonElement
}

function styleLabel({ marker, button }: RouteLabel, selected: boolean) {
  marker.getElement().style.zIndex = selected ? '3' : '2'
  button.setAttribute('aria-pressed', String(selected))
  button.className = `flex items-center gap-1.5 rounded-md border p-0.5 font-display sm:pr-2 text-xs font-bold shadow-md transition-transform hover:-translate-y-0.5 ${
    selected ? 'border-interstate bg-interstate text-white' : 'border-rule bg-white text-asphalt'
  }`
  button.firstElementChild!.className = `grid h-5 w-5 place-items-center rounded ${
    selected ? 'bg-white text-interstate' : 'bg-asphalt text-white'
  }`
}

const TRUCK_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 6.5A1.5 1.5 0 0 1 3.5 5h10A1.5 1.5 0 0 1 15 6.5V8h3.2a1.5 1.5 0 0 1 1.2.6l2.3 3.1c.2.3.3.6.3.9v3.9a1.5 1.5 0 0 1-1.5 1.5h-.6a2.75 2.75 0 0 1-5.3 0H9.4a2.75 2.75 0 0 1-5.3 0h-.6A1.5 1.5 0 0 1 2 16.5zM15 10v3h4.9l-1.9-3zM6.75 16.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5m10 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5"/></svg>'

export function MapView(props: Props) {
  const { plan, selectedRouteId, hoveredCheckpoint, hours, heatLayer, heatVisible } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const popupRef = useRef<Popup | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<ImageData | null>(null)
  const labelMarkers = useRef<RouteLabel[]>([])
  const truckMarkers = useRef<Map<string, Marker>>(new Map())
  const endpointMarkers = useRef<Marker[]>([])
  // Map event handlers are bound once; they read the latest props through this ref.
  const callbacks = useRef(props)
  useLayoutEffect(() => {
    callbacks.current = props
  })
  const [ready, setReady] = useState(false)
  const [basemapFailed, setBasemapFailed] = useState(false)
  const [basemapAttempt, setBasemapAttempt] = useState(0)

  // --- Map setup (once) -------------------------------------------------------
  useEffect(() => {
    const createMap = (style: StyleSpecification): MapLibreMap => {
      const map = new MapLibreMap({
        container: containerRef.current!,
        style,
        center: [-96.5, 38.5],
        zoom: 3.4,
        minZoom: 2.5,
        maxZoom: 14,
        dragRotate: false,
        pitchWithRotate: false,
        attributionControl: { compact: true },
      })
      map.touchZoomRotate.disableRotation()
      map.addControl(new NavigationControl({ showCompass: false }), 'top-left')
      mapRef.current = map
      popupRef.current = new Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 14,
        maxWidth: '280px',
        focusAfterOpen: false,
      })
      // Tile or glyph hiccups after load are recoverable; log them rather than alarm.
      map.on('error', (e) => console.error(e.error))

      map.on('load', () => {
        // Draw our layers under the basemap's place labels so town names stay legible.
        const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
        const empty = { type: 'FeatureCollection' as const, features: [] }
        map.addSource('routes', { type: 'geojson', data: empty })
        map.addSource('checkpoints', { type: 'geojson', data: empty })

        map.addLayer(
          {
            id: 'route-casing',
            type: 'line',
            source: 'routes',
            layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'selected'] },
            paint: {
              'line-color': '#ffffff',
              'line-width': ['interpolate', ['linear'], ['zoom'], 4, ['case', ['==', ['get', 'selected'], 1], 8, 4.5], 10, ['case', ['==', ['get', 'selected'], 1], 13, 7]],
              'line-opacity': ['case', ['==', ['get', 'selected'], 1], 1, 0.7],
            },
          },
          firstLabel,
        )
        map.addLayer(
          {
            id: 'route-line',
            type: 'line',
            source: 'routes',
            layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'selected'] },
            paint: {
              'line-color': RISK_COLOR_EXPR,
              'line-width': ['interpolate', ['linear'], ['zoom'], 4, ['case', ['==', ['get', 'selected'], 1], 4.5, 2.2], 10, ['case', ['==', ['get', 'selected'], 1], 8, 4]],
              'line-opacity': ['case', ['==', ['get', 'selected'], 1], 1, 0.55],
            },
          },
          firstLabel,
        )
        // White dashes over No Travel stretches: a road-closed barricade on the map.
        map.addLayer(
          {
            id: 'route-closed',
            type: 'line',
            source: 'routes',
            filter: ['==', ['get', 'level'], 4],
            layout: { 'line-join': 'round' },
            paint: {
              'line-color': '#ffffff',
              'line-width': ['interpolate', ['linear'], ['zoom'], 4, ['case', ['==', ['get', 'selected'], 1], 2, 1], 10, ['case', ['==', ['get', 'selected'], 1], 3.5, 2]],
              'line-dasharray': [1.2, 1.4],
            },
          },
          firstLabel,
        )
        map.addLayer({
          id: 'route-hit',
          type: 'line',
          source: 'routes',
          paint: { 'line-color': '#000', 'line-width': 16, 'line-opacity': 0 },
        })
        map.addLayer({
          id: 'checkpoint-dots',
          type: 'circle',
          source: 'checkpoints',
          layout: { 'circle-sort-key': ['get', 'selected'] },
          paint: {
            'circle-color': RISK_COLOR_EXPR,
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              4,
              ['case', ['boolean', ['feature-state', 'hover'], false], 7, ['==', ['get', 'selected'], 1], 3.5, 2],
              9,
              ['case', ['boolean', ['feature-state', 'hover'], false], 10, ['==', ['get', 'selected'], 1], 6, 3.5],
            ],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': ['case', ['==', ['get', 'selected'], 1], 1.5, 1],
            'circle-opacity': ['case', ['==', ['get', 'selected'], 1], 1, 0.75],
            'circle-stroke-opacity': ['case', ['==', ['get', 'selected'], 1], 1, 0.75],
          },
        })

        map.on('mousemove', 'checkpoint-dots', (e: MapLayerMouseEvent) => {
          const f = e.features?.[0]
          if (!f) return
          map.getCanvas().style.cursor = 'pointer'
          const ref = { routeId: f.properties.routeId as string, index: f.properties.index as number }
          const current = callbacks.current.hoveredCheckpoint
          if (current?.routeId !== ref.routeId || current.index !== ref.index) {
            callbacks.current.onHoverCheckpoint(ref)
          }
        })
        map.on('mouseleave', 'checkpoint-dots', () => {
          map.getCanvas().style.cursor = ''
          callbacks.current.onHoverCheckpoint(null)
        })
        map.on('mouseenter', 'route-hit', () => (map.getCanvas().style.cursor = 'pointer'))
        map.on('mouseleave', 'route-hit', () => (map.getCanvas().style.cursor = ''))
        map.on('click', 'route-hit', (e: MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties.routeId
          if (typeof id === 'string') callbacks.current.onSelectRoute(id)
        })
        setReady(true)
      })
      return map
    }

    let map: MapLibreMap | null = null
    let resize: ResizeObserver | null = null
    let cancelled = false
    // Fetching the style ourselves means a basemap outage falls back to a plain
    // background instead of a map that never fires 'load'. Transient failures (a
    // dropped connection right after boot) get two retries before that.
    fetchStyle()
      .then((style) => {
        setBasemapFailed(false)
        return style
      })
      .catch(() => {
        setBasemapFailed(true)
        return FALLBACK_STYLE
      })
      .then((style) => {
        if (cancelled) return
        map = createMap(style)
        resize = new ResizeObserver(() => map?.resize())
        resize.observe(containerRef.current!)
      })
    return () => {
      cancelled = true
      resize?.disconnect()
      map?.remove()
      mapRef.current = null
      // Every overlay effect keys on `ready`, so a rebuilt map gets all layers back.
      setReady(false)
    }
  }, [basemapAttempt])

  // When the basemap failed, try again as soon as the browser is back online.
  useEffect(() => {
    if (!basemapFailed) return
    const retry = () => setBasemapAttempt((n) => n + 1)
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [basemapFailed])


  // --- New plan: heatmap source, endpoints, camera ---------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    endpointMarkers.current.forEach((m) => m.remove())
    endpointMarkers.current = []
    truckMarkers.current.forEach((m) => m.remove())
    truckMarkers.current.clear()
    if (!plan) return

    const { heatmap, request } = plan
    if (heatmap) {
      const canvas = (canvasRef.current ??= document.createElement('canvas'))
      canvas.width = heatmap.nx
      canvas.height = heatmap.ny
      imageRef.current = new ImageData(heatmap.nx, heatmap.ny)
      const [w, s, e, n] = heatmap.bounds
      const coordinates: [[number, number], [number, number], [number, number], [number, number]] =
        [
          [w, n],
          [e, n],
          [e, s],
          [w, s],
        ]
      const source = map.getSource<CanvasSource>('heat')
      if (source) {
        source.setCoordinates(coordinates)
      } else {
        map.addSource('heat', { type: 'canvas', canvas, coordinates, animate: false })
        map.addLayer(
          {
            id: 'heat',
            type: 'raster',
            source: 'heat',
            paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
          },
          'route-casing',
        )
      }
    }

    const origin = el(
      'h-4 w-4 rounded-full border-[3px] border-asphalt bg-white shadow',
    )
    origin.title = request.origin.label
    const destination = el(
      'grid h-6 w-6 place-items-center rounded-md bg-asphalt text-white shadow-md',
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3 1.5h1.5V2H13l-2 3.5L13 9H4.5v5.5H3z"/></svg>',
    )
    destination.title = request.destination.label
    endpointMarkers.current = [
      new Marker({ element: origin }).setLngLat([request.origin.lon, request.origin.lat]).addTo(map),
      new Marker({ element: destination, anchor: 'bottom-left', offset: [-4, 2] })
        .setLngLat([request.destination.lon, request.destination.lat])
        .addTo(map),
    ]

    // The timeline dock mounts with the first plan and shrinks the map; measure first.
    map.resize()
    const [sw, ne] = boundsOf(plan.routes)
    map.fitBounds([sw, ne], {
      // Extra right padding keeps routes clear of the heatmap panel.
      padding: { top: 60, bottom: 40, left: 60, right: window.innerWidth >= 1024 ? 300 : 40 },
      duration: prefersReducedMotion() ? 0 : 900,
    })
  }, [plan, ready])

  // --- Route labels: built once per plan --------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    labelMarkers.current.forEach(({ marker }) => marker.remove())
    const routes = plan?.routes ?? []
    labelMarkers.current = routes.map((route) => {
      // MapLibre positions the outer element with a transform on every frame, so the
      // hover lift and styling live on the inner button.
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('aria-label', `Select route ${route.id}, ${formatDuration(route.duration_s)}`)
      // Durations hide on phones, where three labels would pile up; cards still show them.
      button.innerHTML = `<span class="grid h-5 w-5 place-items-center rounded"></span><span class="hidden sm:inline">${formatDuration(route.duration_s)}</span>`
      button.firstElementChild!.textContent = route.id
      button.addEventListener('click', (ev) => {
        ev.stopPropagation()
        callbacks.current.onSelectRoute(route.id)
      })
      const outer = el('')
      outer.appendChild(button)
      const others = routes.filter((r) => r.id !== route.id)
      const marker = new Marker({ element: outer, anchor: 'bottom', offset: [0, -6] })
        .setLngLat(labelAnchor(route, others))
        .addTo(map)
      return { id: route.id, marker, button }
    })
  }, [plan, ready])

  // --- Routes, checkpoints and labels follow the selection --------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const routes = plan?.routes ?? []
    map.getSource<GeoJSONSource>('routes')?.setData(routeFeatures(routes, selectedRouteId))
    map.getSource<GeoJSONSource>('checkpoints')?.setData(checkpointFeatures(routes, selectedRouteId))
    for (const label of labelMarkers.current) styleLabel(label, label.id === selectedRouteId)
  }, [plan, selectedRouteId, ready])

  // --- Hovered checkpoint: highlight + popup ---------------------------------
  useEffect(() => {
    const map = mapRef.current
    const popup = popupRef.current
    if (!map || !ready || !popup) return
    if (!plan || !hoveredCheckpoint) {
      popup.remove()
      return
    }
    const r = plan.routes.findIndex((route) => route.id === hoveredCheckpoint.routeId)
    const route = plan.routes[r]
    const cp = route?.checkpoints[hoveredCheckpoint.index]
    if (!cp) return
    const target = { source: 'checkpoints', id: checkpointFeatureId(r, cp.index) }
    map.setFeatureState(target, { hover: true })
    popup
      .setLngLat([cp.lon, cp.lat])
      .setHTML(checkpointPopupHtml(route, cp, plan.request.load_weight_lb))
      .addTo(map)
    return () => {
      if (map.getSource('checkpoints')) map.setFeatureState(target, { hover: false })
    }
  }, [plan, hoveredCheckpoint, ready])

  // --- Time slider: heatmap frame + truck positions --------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !plan) return
    const departure = Date.parse(plan.request.departure_time) / 1000
    const seconds = hours * 3600

    const canvas = canvasRef.current
    const image = imageRef.current
    const source = map.getSource<CanvasSource>('heat')
    if (plan.heatmap && canvas && image && source) {
      paintHeatmap(image, plan.heatmap, heatLayer, departure + seconds)
      canvas.getContext('2d')!.putImageData(image, 0, 0)
      // A canvas source only re-uploads its texture while playing; one play/pause
      // cycle pushes this frame to the GPU without a continuous render loop.
      source.play()
      source.pause()
    }

    for (const route of plan.routes) {
      const pos = truckPosition(route, seconds)
      const selected = route.id === selectedRouteId
      let marker = truckMarkers.current.get(route.id)
      if (!marker) {
        // Style an inner node: MapLibre owns the outer element's classes and transform.
        const outer = el('pointer-events-none')
        outer.appendChild(el(''))
        marker = new Marker({ element: outer, anchor: 'center' })
        truckMarkers.current.set(route.id, marker.setLngLat(pos.coord).addTo(map))
      }
      marker.getElement().style.zIndex = selected ? '2' : '1'
      const node = marker.getElement().firstElementChild as HTMLElement
      node.className = `grid place-items-center rounded-full border-2 border-white shadow-md ${
        selected ? 'h-7 w-7 bg-asphalt text-white' : 'h-5 w-5 bg-asphalt-soft/80 text-white/90'
      }`
      if (node.dataset.selected !== String(selected)) {
        node.innerHTML = selected ? TRUCK_SVG : `<span class="font-display text-[0.5625rem] font-bold">${route.id}</span>`
        node.dataset.selected = String(selected)
      }
      node.title = `Route ${route.id}${pos.arrived ? ' (arrived)' : ''}`
      marker.setLngLat(pos.coord)
    }
  }, [plan, hours, heatLayer, selectedRouteId, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !map.getLayer('heat')) return
    map.setLayoutProperty('heat', 'visibility', heatVisible && plan?.heatmap ? 'visible' : 'none')
  }, [heatVisible, plan, ready])

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" role="region" aria-label="Route map" />
      {basemapFailed && (
        <div
          role="status"
          className="absolute bottom-10 left-3 flex max-w-xs items-center gap-3 rounded-md bg-white/95 p-2.5 text-xs shadow"
        >
          <span>The basemap didn&rsquo;t load, so routes are drawn on a plain background.</span>
          <button
            type="button"
            onClick={() => setBasemapAttempt((n) => n + 1)}
            className="shrink-0 rounded border border-rule px-2 py-1 font-display font-bold hover:border-asphalt-soft/50"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
}
