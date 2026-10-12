/** Road names drawn as the signs drivers know: interstate and US-route shields. */

function parse(road: string): { kind: 'interstate' | 'us' | 'text'; number: string } {
  const m = road.match(/^(I|US)-(\d+[A-Z]?)$/)
  if (!m) return { kind: 'text', number: road }
  return { kind: m[1] === 'I' ? 'interstate' : 'us', number: m[2] }
}

export function RoadShield({ road }: { road: string }) {
  const { kind, number } = parse(road)
  if (kind === 'text') {
    return (
      <span
        title={road}
        className="max-w-full truncate rounded border border-rule bg-white px-1.5 text-2xs leading-[1.125rem] font-semibold text-asphalt-soft"
      >
        {road}
      </span>
    )
  }
  const wide = number.length > 2
  const width = wide ? 30 : 24
  return (
    <svg
      viewBox={`0 0 ${width} 24`}
      width={width}
      height={22}
      role="img"
      aria-label={kind === 'interstate' ? `Interstate ${number}` : `US Route ${number}`}
      className="shrink-0"
    >
      {kind === 'interstate' ? (
        <>
          <path
            d={`M1 1.5h${width - 2}v10c0 6-${width / 2 - 1} 10.5-${width / 2 - 1} 11C1 22 1 17.5 1 11.5z`}
            fill="#1747a6"
            stroke="#fff"
            strokeWidth="1"
          />
          <path d={`M1.5 2h${width - 3}v5h-${width - 3}z`} fill="#c8102e" />
        </>
      ) : (
        <path
          d={`M2 1.5h${width - 4}c0 3 1.5 4 1.5 7 0 7-4 11-${width / 2 - 1.5} 14C${width / 2 - 2} 19.5 0.5 15.5 0.5 8.5 0.5 5.5 2 4.5 2 1.5z`}
          fill="#fff"
          stroke="#1c2024"
          strokeWidth="1.2"
        />
      )}
      <text
        x={width / 2}
        y={kind === 'interstate' ? 17 : 14.5}
        textAnchor="middle"
        fontFamily="Overpass Variable, Overpass, sans-serif"
        fontWeight={800}
        fontSize={wide ? 8.5 : 10}
        fill={kind === 'interstate' ? '#fff' : '#1c2024'}
      >
        {number}
      </text>
    </svg>
  )
}

export function RoadList({ roads }: { roads: string[] }) {
  if (roads.length === 0) return <span className="text-xs text-muted">Local roads</span>
  return (
    // Wraps rather than truncating: there are at most three, and they tell routes apart.
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {roads.map((road) => (
        <RoadShield key={road} road={road} />
      ))}
    </span>
  )
}
