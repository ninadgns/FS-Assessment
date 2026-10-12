import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { searchPlaces } from '../api'
import type { PlaceInput as PlaceValue } from '../types'

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

interface Props {
  label: string
  placeholder: string
  value: PlaceValue
  onChange: (value: PlaceValue) => void
  error?: string
  marker: 'origin' | 'destination'
}

/** Place search with typeahead suggestions (ARIA 1.2 combobox pattern). */
export function PlaceInput({ label, placeholder, value, onChange, error, marker }: Props) {
  const id = useId()
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const query = useDebounced(value.label.trim(), 250)
  const picked = value.lat !== undefined

  const searching = open && !picked && query.length >= 2
  const {
    data: results = [],
    isFetching,
    isError,
    isSuccess,
  } = useQuery({
    queryKey: ['geocode', query.toLowerCase()],
    queryFn: ({ signal }) => searchPlaces(query, signal),
    enabled: searching,
    staleTime: Infinity,
    retry: false, // typeahead: the next keystroke is the retry
  })
  const showList = searching && results.length > 0
  // One line under the input whenever a search ends without suggestions to pick.
  const status = !searching
    ? null
    : isError
      ? 'Place search is unavailable right now. Try again in a moment.'
      : isSuccess && !isFetching && results.length === 0
        ? `No US or Canadian places match “${query}”.`
        : null

  const choose = (i: number) => {
    const place = results[i]
    if (!place) return
    onChange({ label: place.label, detail: place.detail, lat: place.lat, lon: place.lon })
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && showList && active >= 0) {
      e.preventDefault()
      choose(active)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      <label htmlFor={id} className="eyebrow mb-1 flex items-center gap-1.5">
        {marker === 'origin' ? (
          <span className="h-2.5 w-2.5 rounded-full border-2 border-asphalt" aria-hidden />
        ) : (
          <span className="h-2.5 w-2.5 rounded-[2px] bg-asphalt" aria-hidden />
        )}
        {label}
      </label>
      <div className="relative">
      <input
        id={id}
        className="field pr-8"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value.label}
        onChange={(e) => {
          onChange({ label: e.target.value })
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
        {isFetching && !picked && (
          <span className="absolute top-1/2 right-3 h-3 w-3 -translate-y-1/2 animate-spin rounded-full border-2 border-rule border-t-interstate" />
        )}
      </div>
      {/* Below the input, not inside it, so a long place name never runs under it. */}
      {picked && value.detail && (
        <p className="mt-1 truncate text-xs text-muted" title={value.detail}>
          {value.detail}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-risk-severe">
          {error}
        </p>
      )}
      {status && !error && (
        <p role="status" className="mt-1 text-xs text-muted">
          {status}
        </p>
      )}
      <ul
        id={listId}
        role="listbox"
        aria-label={`${label} suggestions`}
        className={`absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-rule bg-white py-1 shadow-lg ${
          showList ? '' : 'hidden'
        }`}
      >
        {results.map((place, i) => (
          <li
            key={`${place.label}-${place.lat}-${place.lon}`}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={`cursor-pointer px-3 py-1.5 text-sm ${i === active ? 'bg-interstate/10' : 'hover:bg-concrete'}`}
            // mousedown fires before the input's blur, so the pick isn't lost.
            onMouseDown={(e) => {
              e.preventDefault()
              choose(i)
            }}
            onMouseEnter={() => setActive(i)}
          >
            <span className="block font-medium">{place.label}</span>
            {place.detail && <span className="block text-xs text-muted">{place.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
