"""Trip planning pipeline: routes -> checkpoints -> weather -> risk -> recommendation."""

from __future__ import annotations

import logging
import math
import string
from dataclasses import dataclass
from datetime import datetime, timedelta

from django.conf import settings

from .alternatives import ensure_alternatives
from .checkpoints import Checkpoint, sample_checkpoints
from .geo import METERS_PER_MILE
from .heatmap import MIN_CELLS, CorridorGrid, build_corridor_grid
from .providers import get_router
from .providers.base import (
    NoRouteError,
    Place,
    ProviderError,
    RoutePath,
    RoutingProvider,
    TruckProfile,
)
from .providers.openmeteo import HourlySeries, OpenMeteoClient, snap
from .recommendation import Exposure, Recommendation, exposure, recommend
from .risk import Conditions, RiskAssessment, assess, risk_index
from .weather import WeatherSample, sample_at

logger = logging.getLogger(__name__)

ROUTE_OPTIONS = 3
HEATMAP_HOURS = 48


class TooManySamplesError(ProviderError):
    status_code = 422


@dataclass(frozen=True)
class TripRequest:
    origin: Place
    destination: Place
    departure: datetime  # timezone-aware
    load_lb: int
    interval_mi: int


@dataclass(frozen=True)
class AssessedCheckpoint:
    checkpoint: Checkpoint
    weather: WeatherSample
    risk: RiskAssessment


@dataclass(frozen=True)
class RoutePlan:
    name: str  # "A", "B", "C" (fastest first)
    path: RoutePath
    checkpoints: list[AssessedCheckpoint]
    exposure: Exposure


@dataclass(frozen=True)
class Heatmap:
    grid: CorridorGrid
    times: list[int]  # unix seconds, hourly
    # layer -> per-hour list of per-cell values (same order as grid.points)
    layers: dict[str, list[list[float]]]


@dataclass(frozen=True)
class TripPlan:
    request: TripRequest
    provider: str
    routes: list[RoutePlan]
    recommendation: Recommendation
    heatmap: Heatmap | None  # None when the grid forecast couldn't be fetched
    warnings: list[str]


def plan_trip(
    request: TripRequest,
    router: RoutingProvider | None = None,
    weather: OpenMeteoClient | None = None,
) -> TripPlan:
    router = router or get_router()
    weather = weather or OpenMeteoClient()
    truck = TruckProfile(load_lb=request.load_lb, departure=request.departure)

    paths = router.routes(
        request.origin, request.destination, truck, alternatives=ROUTE_OPTIONS - 1
    )
    if not paths:
        raise NoRouteError("No drivable route found between these locations")
    paths = ensure_alternatives(
        router, request.origin, request.destination, truck, paths, ROUTE_OPTIONS
    )
    paths.sort(key=lambda p: p.duration_s)

    interval_m = request.interval_mi * METERS_PER_MILE
    checkpoints = [sample_checkpoints(p, request.departure, interval_m) for p in paths]

    # Checkpoints always get exact weather; the heatmap grid shrinks only if needed
    # to keep the whole plan under the weather API's per-minute allowance.
    checkpoint_cells = {snap((c.lat, c.lon)) for cps in checkpoints for c in cps}
    limit = settings.PLANNER["WEATHER_LOCATION_LIMIT"]
    if len(checkpoint_cells) + MIN_CELLS > limit:
        raise TooManySamplesError(
            f"This trip needs {len(checkpoint_cells)} weather samples at a "
            f"{request.interval_mi}-mile interval, more than the weather service allows "
            "per minute. Try a longer interval."
        )
    grid_budget = min(settings.PLANNER["HEATMAP_CELLS"], limit - len(checkpoint_cells))
    grid = build_corridor_grid(paths, max_cells=grid_budget)

    start = request.departure
    latest_eta = max(cps[-1].eta for cps in checkpoints)
    end = max(start + timedelta(hours=HEATMAP_HOURS + 1), latest_eta + timedelta(hours=1))
    checkpoint_points = [(c.lat, c.lon) for cps in checkpoints for c in cps]

    # Checkpoint weather decides the recommendation, so its requests go out first and
    # must succeed. The heatmap grid is optional: if it fails (e.g. the free tier's
    # per-minute limit), the plan is still complete without it.
    forecasts, grid_error = weather.hourly_prioritized(checkpoint_points, grid.points, start, end)
    warnings: list[str] = []
    heatmap: Heatmap | None = None
    if grid_error:
        logger.warning("heatmap skipped: %s", grid_error)
        warnings.append(f"The corridor heatmap is unavailable right now. {grid_error}")
    else:
        heatmap = _heatmap(grid, forecasts, request.departure, request.load_lb)
    logger.info(
        "plan: %d routes, %d checkpoint cells, %d grid cells",
        len(paths),
        len(checkpoint_cells),
        len(grid),
    )

    routes = [
        _assess_route(name, path, cps, forecasts, request.load_lb)
        for name, path, cps in zip(string.ascii_uppercase, paths, checkpoints, strict=False)
    ]
    return TripPlan(
        request=request,
        provider=router.name,
        routes=routes,
        recommendation=recommend([r.exposure for r in routes]),
        heatmap=heatmap,
        warnings=warnings,
    )


def _assess_route(
    name: str, path: RoutePath, checkpoints: list[Checkpoint], forecasts: dict, load_lb: int
) -> RoutePlan:
    assessed = []
    for cp in checkpoints:
        try:
            sample = sample_at(forecasts[snap((cp.lat, cp.lon))], cp.eta)
        except ValueError as exc:  # forecast came back shorter than requested
            raise ProviderError("Open-Meteo returned an incomplete forecast") from exc
        assessed.append(AssessedCheckpoint(cp, sample, assess(sample.conditions, load_lb)))
    return RoutePlan(
        name=name,
        path=path,
        checkpoints=assessed,
        exposure=exposure(
            [a.risk.level for a in assessed],
            [a.checkpoint.covered_miles for a in assessed],
            path.duration_s,
        ),
    )


def _heatmap(grid: CorridorGrid, forecasts: dict, departure: datetime, load_lb: int) -> Heatmap:
    first = int(departure.timestamp()) // 3600 * 3600
    # One extra frame so the slider can interpolate all the way to departure + 48 h.
    times = [first + h * 3600 for h in range(HEATMAP_HOURS + 2)]
    series: list[HourlySeries] = [forecasts[snap(p)] for p in grid.points]
    layers: dict[str, list[list[float]]] = {"risk": [], "wind": [], "rain": [], "snow": []}
    for t in times:
        risk, wind, rain, snow = [], [], [], []
        for s in series:
            i = s.index_of(t)
            w = (s.wind_mph[i] if i is not None else None) or 0.0
            r = (s.rain_in[i] if i is not None else None) or 0.0
            sn = (s.snow_in[i] if i is not None else None) or 0.0
            # Truncate (not round) so the index never crosses into the next level.
            risk.append(math.floor(risk_index(Conditions(w, r, sn), load_lb) * 100) / 100)
            wind.append(round(w, 1))
            rain.append(round(r, 3))
            snow.append(round(sn, 2))
        layers["risk"].append(risk)
        layers["wind"].append(wind)
        layers["rain"].append(rain)
        layers["snow"].append(snow)
    return Heatmap(grid=grid, times=times, layers=layers)
