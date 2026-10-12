"""Keyless routing fallback using an OSRM server (car profile).

OSRM has no truck profile, so drive times are adjusted to truck speeds by capping
every segment at TRUCK_MAX_SPEED_MPH (most US fleets govern trucks at 65 mph).
"""

from __future__ import annotations

import re
from collections import Counter

from django.conf import settings

from ..geo import METERS_PER_MILE, LatLon
from .base import NoRouteError, Place, ProviderError, RoutePath, TruckProfile
from .http import get_json

TRUCK_MAX_SPEED_MPH = 65
_MAX_SPEED_MPS = TRUCK_MAX_SPEED_MPH * METERS_PER_MILE / 3600


def normalize_road(name: str) -> str:
    """'I 80' -> 'I-80', 'I 20; I 59' -> 'I-20', 'I 80 Express' -> 'I-80'.
    Plain street names are left alone."""
    first = name.split(";")[0].strip()
    match = re.match(r"^([A-Z]{1,3}) (\d+[A-Z]?)\b", first)
    return f"{match[1]}-{match[2]}" if match else first


def _parse_route(route: dict) -> RoutePath:
    coords = [(lat, lon) for lon, lat in route["geometry"]["coordinates"]]
    seg_dist: list[float] = []
    seg_time: list[float] = []
    road_miles: Counter[str] = Counter()
    for leg in route["legs"]:
        annotation = leg["annotation"]
        seg_dist.extend(annotation["distance"])
        seg_time.extend(annotation["duration"])
        for step in leg.get("steps", []):
            # Prefer route numbers ("I-80") over names ("Dwight D. Eisenhower Highway").
            road = normalize_road(step.get("ref") or step.get("name") or "")
            if road:
                road_miles[road] += step["distance"]
    roads = [road for road, _ in road_miles.most_common(3)]
    if len(seg_dist) != len(coords) - 1:
        raise ProviderError("OSRM returned inconsistent route annotations")

    cum_d, cum_t = [0.0], [0.0]
    for d, t in zip(seg_dist, seg_time, strict=True):
        cum_d.append(cum_d[-1] + d)
        cum_t.append(cum_t[-1] + max(t, d / _MAX_SPEED_MPS))
    return RoutePath(coords=coords, cum_distance_m=cum_d, cum_time_s=cum_t, roads=roads)


class OsrmRouter:
    name = "osrm"

    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or settings.PLANNER["OSRM_URL"]).rstrip("/")

    def _request(self, points: list[LatLon], alternatives: int) -> list[RoutePath]:
        coords = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in points)
        data = get_json(
            "the OSRM routing service",
            f"{self.base_url}/route/v1/driving/{coords}",
            params={
                "alternatives": str(alternatives) if alternatives else "false",
                "overview": "full",
                "geometries": "geojson",
                "annotations": "distance,duration",
                "steps": "true",  # per-step road refs, used to name the route
            },
            ok_statuses=frozenset({400}),
        )
        if data.get("code") != "Ok" or not data.get("routes"):
            if data.get("code") in {"NoRoute", "NoSegment"}:
                raise NoRouteError("No drivable route found between these locations")
            raise ProviderError(f"OSRM error: {data.get('message') or data.get('code')}")
        return [_parse_route(r) for r in data["routes"]]

    def routes(
        self, origin: Place, destination: Place, truck: TruckProfile, alternatives: int
    ) -> list[RoutePath]:
        paths = self._request([origin.latlon, destination.latlon], alternatives)
        # OSRM orders by its own (car) duration; re-sort after the truck speed cap.
        return sorted(paths, key=lambda p: p.duration_s)

    def route_through(self, points: list[LatLon], truck: TruckProfile) -> RoutePath:
        return self._request(points, alternatives=0)[0]
