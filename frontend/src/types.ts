/** Shapes returned by the Django API (see backend/planner/serializers.py). */

export type RiskLevel = 0 | 1 | 2 | 3 | 4
export type RiskKey = 'low' | 'moderate' | 'high' | 'severe' | 'no_travel'
export type Condition = 'wind' | 'rain' | 'snow'
export type HeatLayer = 'risk' | 'wind' | 'rain' | 'snow'
export type Criterion = 'no_travel_miles' | 'severe_miles' | 'high_miles' | 'avg_risk' | 'duration_s'
export type SampleInterval = 10 | 25 | 50

export interface Place {
  label: string
  detail?: string
  lat: number
  lon: number
}

/** A place in the form: coordinates are present once a suggestion is picked. */
export interface PlaceInput {
  label: string
  detail?: string
  lat?: number
  lon?: number
}

export interface Weather {
  wind_mph: number
  gust_mph: number
  rain_in_hr: number
  snow_in_hr: number
  temp_f: number | null
  weather_code: number | null
}

export interface RiskFactor {
  condition: Condition
  level: RiskLevel
  value: number
  load_adjusted: boolean
}

export interface Checkpoint {
  index: number
  mile: number
  lat: number
  lon: number
  eta: string
  elapsed_s: number
  covers_miles: [number, number]
  weather: Weather
  risk: {
    level: RiskLevel
    label: string
    drivers: Condition[]
    factors: RiskFactor[]
  }
}

export interface RouteOption {
  id: string
  name: string
  roads: string[]
  source: 'provider' | 'via-point'
  distance_mi: number
  duration_s: number
  arrival_time: string
  rank: number
  recommended: boolean
  exposure: {
    miles: Record<RiskKey, number>
    avg_risk: number
    max_level: RiskLevel
  }
  geometry: {
    coordinates: [number, number][]
    elapsed_s: number[]
    miles: number[]
  }
  checkpoints: Checkpoint[]
}

export interface Comparison {
  route: string
  criterion: Criterion | null
  recommended_value: number | null
  other_value: number | null
}

export interface Heatmap {
  bounds: [number, number, number, number]
  nx: number
  ny: number
  cell_km: number
  cols: number[]
  rows: number[]
  opacity: number[]
  times: number[]
  layers: Record<HeatLayer, number[][]>
}

export interface TripPlan {
  generated_at: string
  provider: string
  request: {
    origin: Place
    destination: Place
    departure_time: string
    load_weight_lb: number
    sample_interval_mi: SampleInterval
  }
  routes: RouteOption[]
  recommendation: {
    route: string
    ranking: string[]
    comparisons: Comparison[]
    all_routes_blocked: boolean
  }
  heatmap: Heatmap | null // null when the grid forecast was unavailable
  warnings: string[]
}

export interface PlanRequest {
  origin: PlaceInput
  destination: PlaceInput
  departure_time: string
  load_weight_lb: number
  sample_interval_mi: SampleInterval
}

export interface CheckpointRef {
  routeId: string
  index: number
}
