"""TomTom truck routing and search (used when TOMTOM_API_KEY is configured)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from ..geo import LatLon, cumulative_distances, lerp
from .base import NoRouteError, Place, ProviderError, RoutePath, TruckProfile
from .http import get_json
from .photon import SEARCH_TIMEOUT_SECONDS

BASE_URL = "https://api.tomtom.com"
LB_TO_KG = 0.45359237

# Typical 5-axle tractor + 53 ft dry van. TomTom uses these for bridge, height and
# weight restrictions; the user-entered load is added to the empty (tare) weight.
TRACTOR_TRAILER_TARE_LB = 35_000
TRUCK_DIMENSIONS = {
    "vehicleLength": 21.9,  # m (72 ft)
    "vehicleWidth": 2.59,  # m (8.5 ft)
    "vehicleHeight": 4.11,  # m (13.5 ft)
    "vehicleNumberOfAxles": 5,
}
TRUCK_MAX_SPEED_KMH = 105  # 65 mph governed speed
MAX_GROSS_LB = 80_000  # US federal limit; heavier loads would need a permit route
# A 400 with one of these codes means "no route"; any other 400 is our request's
# fault, and is raised as a provider error so the OSRM fallback can take over.
NO_ROUTE_CODES = {"NO_ROUTE_FOUND", "MAP_MATCHING_FAILURE"}


def _fill_gaps(known: dict[int, float], geo_cum: list[float]) -> list[float]:
    """Expand sparse per-point values (TomTom `progress`) to every point, interpolating
    by along-route distance between the known points."""
    indices = sorted(known)
    out = [0.0] * len(geo_cum)
    for a, b in zip(indices, indices[1:], strict=False):
        span = geo_cum[b] - geo_cum[a]
        for i in range(a, b + 1):
            t = (geo_cum[i] - geo_cum[a]) / span if span > 0 else 0.0
            out[i] = lerp(known[a], known[b], t)
    return out


def _parse_route(route: dict) -> RoutePath:
    coords: list[LatLon] = [
        (p["latitude"], p["longitude"]) for leg in route["legs"] for p in leg["points"]
    ]
    if len(coords) < 2:
        raise ProviderError("TomTom returned an empty route")
    geo_cum = cumulative_distances(coords)
    last = len(coords) - 1
    summary = route["summary"]

    # Indices are clamped in case TomTom ever counts leg-joining points differently.
    progress = [p for p in route.get("progress") or [] if 0 <= p.get("pointIndex", -1) <= last]
    dist = {p["pointIndex"]: p["distanceInMeters"] for p in progress if "distanceInMeters" in p}
    time = {
        p["pointIndex"]: p["travelTimeInSeconds"] for p in progress if "travelTimeInSeconds" in p
    }
    # Progress always covers the first and last point; fall back to uniform speed if not.
    dist.setdefault(0, 0.0)
    time.setdefault(0, 0.0)
    dist.setdefault(last, float(summary["lengthInMeters"]))
    time.setdefault(last, float(summary["travelTimeInSeconds"]))
    cum_d = _fill_gaps(dist, geo_cum)
    cum_t = _fill_gaps(time, cum_d)

    roads: list[str] = []
    stretches = [
        s for s in route.get("sections", []) if s.get("sectionType") == "IMPORTANT_ROAD_STRETCH"
    ]
    for section in sorted(stretches, key=lambda s: s.get("importantRoadStretchIndex", 99)):
        numbers = section.get("roadNumbers") or []
        name = numbers[0]["text"] if numbers else (section.get("streetName") or {}).get("text")
        if name and name not in roads:
            roads.append(name)
    return RoutePath(coords=coords, cum_distance_m=cum_d, cum_time_s=cum_t, roads=roads[:3])


class TomTomRouter:
    name = "tomtom"

    def __init__(self, api_key: str):
        self.api_key = api_key

    def _request(self, points: list[LatLon], truck: TruckProfile, alternatives: int):
        locations = ":".join(f"{lat:.6f},{lon:.6f}" for lat, lon in points)
        gross_kg = round(min(TRACTOR_TRAILER_TARE_LB + truck.load_lb, MAX_GROSS_LB) * LB_TO_KG)
        # TomTom rejects departures in the past; anything imminent is "now".
        depart_at = (
            "now"
            if truck.departure <= datetime.now(UTC) + timedelta(minutes=1)
            else truck.departure.isoformat(timespec="seconds")
        )
        params = [
            ("key", self.api_key),
            ("travelMode", "truck"),
            ("vehicleCommercial", "true"),
            ("vehicleWeight", gross_kg),
            ("vehicleMaxSpeed", TRUCK_MAX_SPEED_KMH),
            *TRUCK_DIMENSIONS.items(),
            ("maxAlternatives", alternatives),
            ("departAt", depart_at),
            ("traffic", "true"),
            ("routeRepresentation", "polyline"),
            ("extendedRouteRepresentation", "distance"),
            ("extendedRouteRepresentation", "travelTime"),
            ("sectionType", "importantRoadStretch"),
        ]
        data = get_json(
            "the TomTom routing service",
            f"{BASE_URL}/routing/1/calculateRoute/{locations}/json",
            params=params,
            ok_statuses=frozenset({400}),
        )
        if not data.get("routes"):
            error = data.get("detailedError") or {}
            message = error.get("message") or "no route found"
            if error.get("code") in NO_ROUTE_CODES or "routes" in data:
                raise NoRouteError(f"TomTom: {message}")
            raise ProviderError(f"TomTom rejected the request: {message}")
        try:
            return [_parse_route(r) for r in data["routes"]]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("TomTom returned a route in an unexpected format") from exc

    def routes(
        self, origin: Place, destination: Place, truck: TruckProfile, alternatives: int
    ) -> list[RoutePath]:
        return self._request([origin.latlon, destination.latlon], truck, alternatives)

    def route_through(self, points: list[LatLon], truck: TruckProfile) -> RoutePath:
        return self._request(points, truck, alternatives=0)[0]


class TomTomGeocoder:
    name = "tomtom"

    def __init__(self, api_key: str, countries: str):
        self.api_key = api_key
        self.countries = countries

    def search(self, query: str, limit: int = 5) -> list[Place]:
        data = get_json(
            "the TomTom search service",
            f"{BASE_URL}/search/2/search/{quote(query, safe='')}.json",
            params={
                "key": self.api_key,
                "typeahead": "true",
                "limit": limit,
                "countrySet": self.countries,
            },
            timeout=SEARCH_TIMEOUT_SECONDS,
        )
        places = []
        for result in data.get("results", []):
            address = result.get("address", {})
            freeform = address.get("freeformAddress", "")
            poi_name = (result.get("poi") or {}).get("name")
            places.append(
                Place(
                    label=poi_name or freeform,
                    detail=freeform if poi_name else address.get("country", ""),
                    lat=result["position"]["lat"],
                    lon=result["position"]["lon"],
                )
            )
        return places
