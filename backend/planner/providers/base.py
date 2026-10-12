"""Provider-neutral types shared by the routing, geocoding and weather clients."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

from ..geo import LatLon


class ProviderError(Exception):
    """An upstream API failed or returned something unusable."""

    status_code = 502

    def __init__(self, message: str, *, status_code: int | None = None):
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


class NoRouteError(ProviderError):
    status_code = 422


class RateLimitedError(ProviderError):
    status_code = 503


@dataclass(frozen=True)
class Place:
    label: str
    lat: float
    lon: float
    detail: str = ""

    @property
    def latlon(self) -> LatLon:
        return (self.lat, self.lon)


@dataclass
class RoutePath:
    """A drivable route with per-vertex cumulative distance (m) and drive time (s)."""

    coords: list[LatLon]
    cum_distance_m: list[float]
    cum_time_s: list[float]
    roads: list[str] = field(default_factory=list)  # most significant road names first
    source: str = ""  # "provider" or "via-point" (synthesized alternative)

    def __post_init__(self) -> None:
        n = len(self.coords)
        if n < 2 or len(self.cum_distance_m) != n or len(self.cum_time_s) != n:
            raise ValueError("route needs >=2 points with matching distance/time arrays")

    @property
    def distance_m(self) -> float:
        return self.cum_distance_m[-1]

    @property
    def duration_s(self) -> float:
        return self.cum_time_s[-1]


@dataclass(frozen=True)
class TruckProfile:
    load_lb: int
    departure: datetime


class RoutingProvider(Protocol):
    name: str

    def routes(
        self, origin: Place, destination: Place, truck: TruckProfile, alternatives: int
    ) -> list[RoutePath]:
        """Fastest route first, followed by up to `alternatives` alternatives."""
        ...

    def route_through(self, points: list[LatLon], truck: TruckProfile) -> RoutePath:
        """A single route visiting `points` in order."""
        ...


class Geocoder(Protocol):
    name: str

    def search(self, query: str, limit: int = 5) -> list[Place]: ...
