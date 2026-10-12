import type { Place, PlanRequest, TripPlan } from './types'

export class ApiError extends Error {
  readonly fields: Record<string, string>

  constructor(message: string, fields: Record<string, string> = {}) {
    super(message)
    this.fields = fields
  }
}

/** Flattens DRF error bodies ({"field": ["msg"]}, {"detail": "msg"}) into one message. */
function toApiError(status: number, body: unknown): ApiError {
  if (body && typeof body === 'object') {
    const fields: Record<string, string> = {}
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const first = Array.isArray(value) ? value[0] : value
      if (typeof first === 'string') fields[key] = first
      else if (first && typeof first === 'object') {
        const nested = Object.values(first as Record<string, unknown>).flat()[0]
        if (typeof nested === 'string') fields[key] = nested
      }
    }
    const message = fields.detail ?? fields.non_field_errors ?? Object.values(fields)[0]
    if (message) return new ApiError(message, fields)
  }
  if (status === 429) return new ApiError('Too many requests. Wait a moment and try again.')
  return new ApiError(`The planner is unavailable (HTTP ${status}). Try again shortly.`)
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new ApiError("Can't reach the planner. Check your connection.")
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw toApiError(response.status, body)
  return body as T
}

function fetchPlan(body: PlanRequest): Promise<TripPlan> {
  return request<TripPlan>('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Stress-test data (?data=worst etc.) runs in dev, or in a production build made with
// VITE_TEST_DATA=true for measuring performance without React's dev overhead. The last
// real plan is cached so switching modes reshapes it instantly instead of re-querying.
const TEST_DATA = import.meta.env.DEV || import.meta.env.VITE_TEST_DATA === 'true'
let devCache: { key: string; plan: TripPlan } | null = null

export async function planTrip(body: PlanRequest): Promise<TripPlan> {
  if (!TEST_DATA) return fetchPlan(body)
  const dev = await import('./dev/dataModes')
  const mode = dev.currentMode()
  if (mode === 'none') throw new ApiError('No drivable route found between these locations')
  const { departure_time: _, ...rest } = body
  const key = JSON.stringify(rest)
  if (devCache?.key !== key) devCache = { key, plan: await fetchPlan(body) }
  return dev.transformPlan(devCache.plan, mode)
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const data = await request<{ results: Place[] }>(
    `/api/geocode?q=${encodeURIComponent(query)}`,
    { signal },
  )
  if (!TEST_DATA) return data.results
  const dev = await import('./dev/dataModes')
  return dev.transformPlaces(data.results, dev.currentMode())
}
