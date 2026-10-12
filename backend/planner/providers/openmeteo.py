"""Open-Meteo hourly forecast client with batching, de-duplication and caching.

Open-Meteo answers each request from the nearest model grid cell (about 3 km for
HRRR over the US, 11-25 km for GFS elsewhere), so locations are snapped to a
0.05 degree lattice before fetching. That costs no meaningful accuracy and lets
overlapping routes, the heatmap grid and repeat plans share the same fetches.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime

from django.conf import settings
from django.core.cache import cache

from ..geo import LatLon
from .base import ProviderError
from .http import get_json

FREE_URL = "https://api.open-meteo.com/v1/forecast"
CUSTOMER_URL = "https://customer-api.open-meteo.com/v1/forecast"
HOURLY_VARIABLES = (
    "wind_speed_10m",
    "wind_gusts_10m",
    "rain",
    "showers",
    "snowfall",
    "temperature_2m",
    "weather_code",
)
SNAP_DEGREES = 0.05
BATCH_SIZE = 100  # locations per request (keeps URLs well under common limits)
MAX_PARALLEL_REQUESTS = 4


def snap(point: LatLon) -> LatLon:
    lat, lon = point
    return (
        round(round(lat / SNAP_DEGREES) * SNAP_DEGREES, 2),
        round(round(lon / SNAP_DEGREES) * SNAP_DEGREES, 2),
    )


@dataclass(frozen=True)
class HourlySeries:
    """Hourly forecast for one location. Index i is the hour starting at times[0] + i h.

    Wind, temperature and weather code are instantaneous values at the hour.
    Rain (rain + showers) and snow are totals over the *preceding* hour, i.e. the
    value at hour H is the rate (in/hr) for the interval (H-1h, H].
    """

    times: tuple[int, ...]  # unix seconds, hourly
    wind_mph: tuple[float | None, ...]
    gust_mph: tuple[float | None, ...]
    rain_in: tuple[float | None, ...]
    snow_in: tuple[float | None, ...]
    temp_f: tuple[float | None, ...]
    weather_code: tuple[int | None, ...]

    def index_of(self, epoch: int) -> int | None:
        i = (epoch - self.times[0]) // 3600
        return i if 0 <= i < len(self.times) else None


def _sum_nullable(a: float | None, b: float | None) -> float | None:
    if a is None and b is None:
        return None
    # Rounded to the API's precision so 0.09 + 0.01 is exactly 0.10, not 0.0999...
    return round((a or 0.0) + (b or 0.0), 3)


def _parse_location(payload: dict) -> HourlySeries:
    hourly = payload["hourly"]
    return HourlySeries(
        times=tuple(hourly["time"]),
        wind_mph=tuple(hourly["wind_speed_10m"]),
        gust_mph=tuple(hourly["wind_gusts_10m"]),
        rain_in=tuple(map(_sum_nullable, hourly["rain"], hourly["showers"])),
        snow_in=tuple(hourly["snowfall"]),
        temp_f=tuple(hourly["temperature_2m"]),
        weather_code=tuple(hourly["weather_code"]),
    )


class OpenMeteoClient:
    def __init__(self, api_key: str | None = None):
        self.api_key = api_key if api_key is not None else settings.PLANNER["OPEN_METEO_API_KEY"]
        self.url = CUSTOMER_URL if self.api_key else FREE_URL
        self.cache_seconds = settings.PLANNER["WEATHER_CACHE_SECONDS"]

    def hourly(
        self, points: Iterable[LatLon], start: datetime, end: datetime
    ) -> dict[LatLon, HourlySeries]:
        """Forecasts for [start, end] (whole UTC hours), keyed by `snap(point)`."""
        forecasts, _ = self.hourly_prioritized(points, (), start, end)
        return forecasts

    def hourly_prioritized(
        self,
        required: Iterable[LatLon],
        optional: Iterable[LatLon],
        start: datetime,
        end: datetime,
    ) -> tuple[dict[LatLon, HourlySeries], ProviderError | None]:
        """Fetch `required` and `optional` locations on one request pool, required first.

        Under a per-minute quota, requests sent first are counted first, so queueing the
        required batches ahead of the optional ones protects them. A failed required
        batch raises; a failed optional batch is returned as the second value and its
        locations are simply missing from the result.
        """
        start_h, end_h = _floor_hour(start), _ceil_hour(end)
        required_cells = sorted({snap(p) for p in required})
        optional_cells = sorted({snap(p) for p in optional} - set(required_cells))
        keys = {
            cell: f"om:{cell[0]:.2f}:{cell[1]:.2f}:{start_h}:{end_h}"
            for cell in required_cells + optional_cells
        }
        cached = cache.get_many(list(keys.values()))
        result = {cell: cached[key] for cell, key in keys.items() if key in cached}

        def batches(cells: list[LatLon]) -> list[list[LatLon]]:
            missing = [cell for cell in cells if cell not in result]
            return [missing[i : i + BATCH_SIZE] for i in range(0, len(missing), BATCH_SIZE)]

        fresh: dict[LatLon, HourlySeries] = {}
        optional_error: ProviderError | None = None
        with ThreadPoolExecutor(max_workers=MAX_PARALLEL_REQUESTS) as pool:
            fetch = lambda b: pool.submit(self._fetch, b, start_h, end_h)  # noqa: E731
            required_jobs = [fetch(b) for b in batches(required_cells)]
            optional_jobs = [fetch(b) for b in batches(optional_cells)]
            try:
                for job in required_jobs:
                    fresh.update(job.result())
            except ProviderError:
                pool.shutdown(cancel_futures=True)
                raise
            for job in optional_jobs:
                try:
                    fresh.update(job.result())
                except ProviderError as exc:
                    optional_error = exc
        if fresh:
            cache.set_many({keys[cell]: s for cell, s in fresh.items()}, self.cache_seconds)
        result.update(fresh)
        return result, optional_error

    def _fetch(self, cells: list[LatLon], start_h: int, end_h: int) -> dict[LatLon, HourlySeries]:
        params = {
            "latitude": ",".join(f"{lat:.2f}" for lat, _ in cells),
            "longitude": ",".join(f"{lon:.2f}" for _, lon in cells),
            "hourly": ",".join(HOURLY_VARIABLES),
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",  # also converts snowfall to inches
            "temperature_unit": "fahrenheit",
            "timeformat": "unixtime",
            "timezone": "GMT",
            "start_hour": _iso_hour(start_h),
            "end_hour": _iso_hour(end_h),
        }
        if self.api_key:
            params["apikey"] = self.api_key
        data = get_json("the Open-Meteo weather service", self.url, params=params)
        payloads = data if isinstance(data, list) else [data]
        if len(payloads) != len(cells):
            raise ProviderError("Open-Meteo returned an unexpected number of locations")
        return {cell: _parse_location(p) for cell, p in zip(cells, payloads, strict=True)}


def _floor_hour(dt: datetime) -> int:
    ts = int(dt.timestamp())
    return ts - ts % 3600


def _ceil_hour(dt: datetime) -> int:
    return int(math.ceil(dt.timestamp() / 3600) * 3600)


def _iso_hour(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, tz=UTC).strftime("%Y-%m-%dT%H:%M")
