"""Guarantee three route options when the routing API returns fewer.

OSRM often returns only one or two alternatives on long trips, and TomTom can too.
Missing options are synthesized by routing through a via point pushed sideways off
the fastest route, then keeping candidates that are reasonably fast and actually
take different roads.
"""

from __future__ import annotations

import logging
import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import shapely

from .geo import LatLon, from_mercator, haversine_m, locate, mercator_array
from .providers.base import Place, ProviderError, RoutePath, RoutingProvider, TruckProfile

logger = logging.getLogger(__name__)

# (fraction along the fastest route, sideways offset as a share of the O-D distance);
# positive offsets go left of the direction of travel.
VIA_CANDIDATES = (
    (0.5, 0.15),
    (0.5, -0.15),
    (0.33, 0.12),
    (0.33, -0.12),
    (0.67, 0.12),
    (0.67, -0.12),
)
MAX_SLOWDOWN = 1.5  # an alternative may take at most 50% longer than the fastest route
MAX_SHARED = 0.75  # share of an alternative allowed within SHARED_RADIUS_M of another option
SHARED_RADIUS_M = 1_500
SAMPLE_SPACING_M = 2_000


def _sample_points(path: RoutePath) -> np.ndarray:
    """Mercator points roughly every SAMPLE_SPACING_M along the route."""
    marks = np.arange(0, path.distance_m, SAMPLE_SPACING_M)
    idx = np.searchsorted(path.cum_distance_m, marks).clip(0, len(path.coords) - 1)
    return mercator_array([path.coords[i] for i in np.unique(idx)])


def shared_fraction(candidate: RoutePath, other: RoutePath) -> float:
    """Share of `candidate` that runs within SHARED_RADIUS_M of `other`."""
    pts = _sample_points(candidate)
    mean_lat = float(
        np.mean([c[0] for c in candidate.coords[:: max(1, len(candidate.coords) // 50)]])
    )
    radius = SHARED_RADIUS_M / math.cos(math.radians(mean_lat))  # ground m -> Mercator m
    line = shapely.LineString(mercator_array(other.coords))
    dists = shapely.distance(shapely.points(pts), line)
    return float(np.mean(dists <= radius))


def via_points(base: RoutePath, origin: Place, destination: Place) -> list[LatLon]:
    o, d = mercator_array([origin.latlon, destination.latlon])
    span = np.linalg.norm(d - o)
    if span == 0:
        return []
    left = np.array([-(d - o)[1], (d - o)[0]]) / span
    points = []
    for fraction, offset in VIA_CANDIDATES:
        i, t = locate(base.cum_distance_m, fraction * base.distance_m)
        anchor = mercator_array([base.coords[i], base.coords[i + 1]])
        p = anchor[0] + (anchor[1] - anchor[0]) * t + left * offset * span
        points.append(from_mercator(float(p[0]), float(p[1])))
    return points


def trim_spurs(
    path: RoutePath, near_m: float = 150, min_loop_m: float = 1_000, max_loop_m: float = 60_000
) -> RoutePath:
    """Remove out-and-back detours, typically created when a via point lands on a
    side road: the route drives to it and returns along the same road. Detected as
    two points closer than `near_m` with a long stretch of road between them."""
    coords, cum = path.coords, path.cum_distance_m
    mean_lat = math.radians(sum(c[0] for c in coords) / len(coords))
    xy = mercator_array(coords) * math.cos(mean_lat)  # roughly ground metres
    buckets: dict[tuple[int, int], list[int]] = {}
    spans: list[tuple[int, int]] = []
    for j, (x, y) in enumerate(xy):
        bx, by = int(x // near_m), int(y // near_m)
        earliest = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in buckets.get((bx + dx, by + dy), ()):
                    loop = cum[j] - cum[i]
                    if (
                        min_loop_m < loop < max_loop_m
                        and (earliest is None or i < earliest)
                        and math.hypot(x - xy[i][0], y - xy[i][1]) < near_m
                    ):
                        earliest = i
        if earliest is not None:
            spans.append((earliest, j))
        buckets.setdefault((bx, by), []).append(j)
    if not spans:
        return path

    # Keep the widest spans first; nested pairs from the same spur are skipped.
    chosen: list[tuple[int, int]] = []
    for i, j in sorted(spans, key=lambda s: s[1] - s[0], reverse=True):
        if all(j <= a or i >= b for a, b in chosen):
            chosen.append((i, j))
    removed = np.zeros(len(coords), dtype=bool)
    for i, j in chosen:
        removed[i + 1 : j] = True
    keep = np.flatnonzero(~removed).tolist()

    new_d, new_t = [0.0], [0.0]
    for a, b in zip(keep, keep[1:], strict=False):
        if b == a + 1:
            new_d.append(new_d[-1] + cum[b] - cum[a])
            new_t.append(new_t[-1] + path.cum_time_s[b] - path.cum_time_s[a])
        else:  # bridge across the removed spur (< near_m), at ~35 mph
            gap = haversine_m(coords[a], coords[b])
            new_d.append(new_d[-1] + gap)
            new_t.append(new_t[-1] + gap / 15.6)
    return RoutePath(
        coords=[coords[k] for k in keep],
        cum_distance_m=new_d,
        cum_time_s=new_t,
        roads=path.roads,
        source=path.source,
    )


def ensure_alternatives(
    router: RoutingProvider,
    origin: Place,
    destination: Place,
    truck: TruckProfile,
    routes: list[RoutePath],
    target: int = 3,
) -> list[RoutePath]:
    for r in routes:
        r.source = r.source or "provider"
    if len(routes) >= target or not routes:
        return routes[:target]

    fastest = min(routes, key=lambda r: r.duration_s)

    def attempt(via: LatLon) -> RoutePath | None:
        try:
            path = router.route_through([origin.latlon, via, destination.latlon], truck)
        except ProviderError as exc:
            logger.info("via-point route failed: %s", exc)
            return None
        path.source = "via-point"
        return trim_spurs(path)

    with ThreadPoolExecutor(max_workers=3) as pool:
        candidates = [c for c in pool.map(attempt, via_points(fastest, origin, destination)) if c]

    options = list(routes)
    for candidate in sorted(candidates, key=lambda c: c.duration_s):
        if len(options) >= target:
            break
        if candidate.duration_s > MAX_SLOWDOWN * fastest.duration_s:
            continue
        if all(shared_fraction(candidate, o) <= MAX_SHARED for o in options):
            options.append(candidate)
    return options
