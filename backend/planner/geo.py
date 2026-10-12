"""Small geodesy helpers: distances, positions along a polyline, Web Mercator, simplification."""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Sequence

import numpy as np

EARTH_RADIUS_M = 6_371_008.8
MERCATOR_RADIUS_M = 6_378_137.0
METERS_PER_MILE = 1609.344

LatLon = tuple[float, float]


def haversine_m(a: LatLon, b: LatLon) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def cumulative_distances(coords: Sequence[LatLon]) -> list[float]:
    cum = [0.0]
    for prev, cur in zip(coords, coords[1:], strict=False):
        cum.append(cum[-1] + haversine_m(prev, cur))
    return cum


def locate(cum: Sequence[float], target: float) -> tuple[int, float]:
    """Index of the segment containing `target` along `cum`, and the fraction within it."""
    if target <= cum[0]:
        return 0, 0.0
    if target >= cum[-1]:
        return len(cum) - 2, 1.0
    i = bisect_right(cum, target) - 1
    span = cum[i + 1] - cum[i]
    return i, (target - cum[i]) / span if span > 0 else 0.0


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def to_mercator(lat: float, lon: float) -> tuple[float, float]:
    lat = max(min(lat, 85.05112878), -85.05112878)
    x = MERCATOR_RADIUS_M * math.radians(lon)
    y = MERCATOR_RADIUS_M * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def from_mercator(x: float, y: float) -> LatLon:
    lon = math.degrees(x / MERCATOR_RADIUS_M)
    lat = math.degrees(2 * math.atan(math.exp(y / MERCATOR_RADIUS_M)) - math.pi / 2)
    return lat, lon


def mercator_array(coords: Sequence[LatLon]) -> np.ndarray:
    """(n, 2) array of Web Mercator x/y for a list of (lat, lon)."""
    arr = np.asarray(coords, dtype=float)
    lat = np.clip(arr[:, 0], -85.05112878, 85.05112878)
    x = MERCATOR_RADIUS_M * np.radians(arr[:, 1])
    y = MERCATOR_RADIUS_M * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    return np.column_stack([x, y])


def simplify_indices(xy: np.ndarray, tolerance: float) -> list[int]:
    """Ramer-Douglas-Peucker on projected points; returns the indices to keep.

    Returning indices (rather than new coordinates) lets callers carry per-vertex
    attributes such as cumulative time through the simplification.
    """
    n = len(xy)
    if n < 3:
        return list(range(n))
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        a, b = xy[start], xy[end]
        seg = b - a
        seg_len = math.hypot(seg[0], seg[1])
        pts = xy[start + 1 : end]
        if seg_len == 0:
            dists = np.hypot(pts[:, 0] - a[0], pts[:, 1] - a[1])
        else:
            dists = np.abs(seg[0] * (pts[:, 1] - a[1]) - seg[1] * (pts[:, 0] - a[0])) / seg_len
        k = int(np.argmax(dists))
        if dists[k] > tolerance:
            mid = start + 1 + k
            keep[mid] = True
            stack.append((start, mid))
            stack.append((mid, end))
    return np.flatnonzero(keep).tolist()
