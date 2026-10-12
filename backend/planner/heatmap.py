"""Weather grid covering the trip corridor, for the 0-48 h heatmap.

The grid is square in Web Mercator, the map's own projection, so the frontend can
paint it straight into a raster (one pixel per cell) and let the GPU interpolate
smoothly between cells. Cell size is picked from a fixed ladder so that grids from
different trips line up and share cached forecasts.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import shapely

from .geo import LatLon, from_mercator, mercator_array, simplify_indices
from .providers.base import RoutePath

# 8 km to ~180 km (Mercator metres) in 2^(1/4) steps, fine enough to use most of the budget.
CELL_LADDER_M = tuple(round(8_000 * 2 ** (k / 4)) for k in range(19))
MIN_CELLS = 120


def corridor_half_width_m(longest_route_m: float) -> float:
    """Wide enough to show approaching weather; scales with trip length (ground metres)."""
    return min(max(0.04 * longest_route_m, 25_000), 70_000)


@dataclass(frozen=True)
class CorridorGrid:
    cell_m: float  # Mercator metres
    nx: int
    ny: int
    bounds: tuple[float, float, float, float]  # west, south, east, north (degrees)
    cols: list[int]
    rows: list[int]  # 0 = northernmost row, matching image coordinates
    points: list[LatLon]  # cell centres
    opacity: list[float]  # 1 near the routes, fading to 0 at the corridor edge

    def __len__(self) -> int:
        return len(self.points)


def build_corridor_grid(paths: Sequence[RoutePath], max_cells: int) -> CorridorGrid:
    max_cells = max(max_cells, MIN_CELLS)
    longest = max(p.distance_m for p in paths)
    mean_lat = float(
        np.mean([c[0] for p in paths for c in p.coords[:: max(1, len(p.coords) // 100)]])
    )
    to_mercator_scale = 1 / math.cos(math.radians(mean_lat))
    half_width = corridor_half_width_m(longest) * to_mercator_scale

    lines = []
    for p in paths:
        xy = mercator_array(p.coords)
        lines.append(shapely.LineString(xy[simplify_indices(xy, half_width / 50)]))
    routes = shapely.MultiLineString(lines)
    corridor = routes.buffer(half_width, quad_segs=6)

    # Smallest ladder step whose cell count fits the budget.
    start = next(
        (k for k, c in enumerate(CELL_LADDER_M) if c * c * max_cells >= corridor.area),
        len(CELL_LADDER_M) - 1,
    )
    for cell in CELL_LADDER_M[start:]:
        grid = _grid(corridor, routes, half_width, cell)
        if len(grid) <= max_cells:
            return grid
    return grid


def _grid(corridor, routes, half_width: float, cell: float) -> CorridorGrid:
    minx, miny, maxx, maxy = corridor.bounds
    ix0, ix1 = math.floor(minx / cell), math.ceil(maxx / cell)
    iy0, iy1 = math.floor(miny / cell), math.ceil(maxy / cell)
    ix, iy = np.meshgrid(np.arange(ix0, ix1), np.arange(iy0, iy1))
    ix, iy = ix.ravel(), iy.ravel()
    x, y = (ix + 0.5) * cell, (iy + 0.5) * cell
    dist = shapely.distance(shapely.points(x, y), routes)
    inside = dist < half_width
    # Full strength within half the corridor width, then a linear fade to the edge.
    opacity = np.clip((half_width - dist[inside]) / (0.5 * half_width), 0, 1)

    west, north = from_mercator(ix0 * cell, iy1 * cell)[::-1]
    east, south = from_mercator(ix1 * cell, iy0 * cell)[::-1]
    return CorridorGrid(
        cell_m=cell,
        nx=int(ix1 - ix0),
        ny=int(iy1 - iy0),
        bounds=(west, south, east, north),
        cols=(ix[inside] - ix0).tolist(),
        rows=(iy1 - 1 - iy[inside]).tolist(),
        points=[
            from_mercator(float(a), float(b)) for a, b in zip(x[inside], y[inside], strict=True)
        ],
        opacity=np.round(opacity, 2).tolist(),
    )
