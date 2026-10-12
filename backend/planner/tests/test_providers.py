from datetime import UTC, datetime

import httpx
import pytest
import respx
from django.core.cache import cache

from planner.alternatives import shared_fraction, trim_spurs
from planner.geo import cumulative_distances
from planner.providers import FallbackRouter
from planner.providers.base import (
    NoRouteError,
    Place,
    ProviderError,
    RateLimitedError,
    RoutePath,
    TruckProfile,
)
from planner.providers.openmeteo import FREE_URL, OpenMeteoClient, snap
from planner.providers.osrm import OsrmRouter, normalize_road
from planner.providers.photon import PhotonGeocoder
from planner.providers.tomtom import TomTomRouter

from .factories import straight_route

TRUCK = TruckProfile(load_lb=30_000, departure=datetime(2026, 10, 10, 14, tzinfo=UTC))
ORIGIN, DEST = Place("A", 40.0, -100.0), Place("B", 40.0, -99.0)


@pytest.fixture(autouse=True)
def clear_cache():
    cache.clear()


# --- OSRM ------------------------------------------------------------------------


def osrm_route(durations):
    coords = [[-100.0 + 0.01 * i, 40.0] for i in range(len(durations) + 1)]
    return {
        "geometry": {"coordinates": coords},
        "legs": [
            {
                "annotation": {"distance": [1000.0] * len(durations), "duration": durations},
                "steps": [
                    {"ref": "I 70", "name": "", "distance": 2500.0},
                    {"ref": "", "name": "Main Street", "distance": 500.0},
                ],
            }
        ],
    }


@respx.mock
def test_osrm_caps_segments_at_truck_speed_and_names_roads():
    respx.get(url__startswith="https://router.project-osrm.org/route/v1/driving/").mock(
        return_value=httpx.Response(
            200, json={"code": "Ok", "routes": [osrm_route([20.0, 60.0, 30.0])]}
        )
    )
    (path,) = OsrmRouter().routes(ORIGIN, DEST, TRUCK, alternatives=0)
    # 1 km at 65 mph takes 34.4 s, so the 20 s and 30 s car segments are slowed down.
    assert path.cum_time_s[-1] == pytest.approx(34.41 + 60 + 34.41, abs=0.05)
    assert path.distance_m == 3000
    assert path.roads == ["I-70", "Main Street"]


@respx.mock
def test_osrm_no_route_is_a_client_error():
    respx.get(url__startswith="https://router.project-osrm.org/").mock(
        return_value=httpx.Response(400, json={"code": "NoRoute", "message": "Impossible route"})
    )
    with pytest.raises(NoRouteError):
        OsrmRouter().routes(ORIGIN, DEST, TRUCK, alternatives=2)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("I 80", "I-80"),
        ("US 6", "US-6"),
        ("I 20; I 59", "I-20"),
        ("I 80 Express", "I-80"),
        ("Main Street", "Main Street"),
    ],
)
def test_normalize_road(raw, expected):
    assert normalize_road(raw) == expected


# --- TomTom ----------------------------------------------------------------------


@respx.mock
def test_tomtom_parses_progress_and_important_roads():
    points = [{"latitude": 40.0, "longitude": -100.0 + 0.01 * i} for i in range(5)]
    route = {
        "summary": {"lengthInMeters": 3400, "travelTimeInSeconds": 200},
        "legs": [{"points": points}],
        # Sparse progress: missing points are interpolated by distance.
        "progress": [
            {"pointIndex": 0, "distanceInMeters": 0, "travelTimeInSeconds": 0},
            {"pointIndex": 2, "distanceInMeters": 1700, "travelTimeInSeconds": 150},
            {"pointIndex": 4, "distanceInMeters": 3400, "travelTimeInSeconds": 200},
        ],
        "sections": [
            {
                "sectionType": "IMPORTANT_ROAD_STRETCH",
                "importantRoadStretchIndex": 1,
                "streetName": {"text": "Broadway"},
            },
            {
                "sectionType": "IMPORTANT_ROAD_STRETCH",
                "importantRoadStretchIndex": 0,
                "roadNumbers": [{"text": "I-70"}, {"text": "US-40"}],
            },
            {"sectionType": "TRAVEL_MODE", "travelMode": "truck"},
        ],
    }
    mock = respx.get(url__startswith="https://api.tomtom.com/routing/1/calculateRoute/").mock(
        return_value=httpx.Response(200, json={"routes": [route]})
    )
    (path,) = TomTomRouter("key").routes(ORIGIN, DEST, TRUCK, alternatives=2)
    assert path.cum_distance_m[2] == 1700
    assert path.cum_time_s[1] == pytest.approx(75, abs=0.5)
    assert path.duration_s == 200
    assert path.roads == ["I-70", "Broadway"]
    params = mock.calls.last.request.url.params
    assert params["travelMode"] == "truck"
    assert params["vehicleWeight"] == str(round(65_000 * 0.45359237))  # tare + load
    assert params.get_list("extendedRouteRepresentation") == ["distance", "travelTime"]


@respx.mock
def test_tomtom_no_route_code_is_a_no_route_error():
    body = {"detailedError": {"code": "NO_ROUTE_FOUND", "message": "No route found."}}
    respx.get(url__startswith="https://api.tomtom.com/").mock(
        return_value=httpx.Response(400, json=body)
    )
    with pytest.raises(NoRouteError):
        TomTomRouter("key").routes(ORIGIN, DEST, TRUCK, alternatives=2)


@respx.mock
def test_other_tomtom_400s_fall_back_to_osrm():
    body = {"detailedError": {"code": "INVALID_REQUEST", "message": "Bad parameter"}}
    respx.get(url__startswith="https://api.tomtom.com/").mock(
        return_value=httpx.Response(400, json=body)
    )
    respx.get(url__startswith="https://router.project-osrm.org/").mock(
        return_value=httpx.Response(200, json={"code": "Ok", "routes": [osrm_route([60.0])]})
    )
    with pytest.raises(ProviderError) as exc:
        TomTomRouter("key").routes(ORIGIN, DEST, TRUCK, alternatives=2)
    assert not isinstance(exc.value, NoRouteError)

    router = FallbackRouter(TomTomRouter("key"), OsrmRouter())
    assert len(router.routes(ORIGIN, DEST, TRUCK, alternatives=2)) == 1
    assert router.name == "osrm"


@respx.mock
def test_tomtom_caps_gross_weight_at_the_legal_limit():
    mock = respx.get(url__startswith="https://api.tomtom.com/").mock(
        return_value=httpx.Response(400, json={"detailedError": {"code": "NO_ROUTE_FOUND"}})
    )
    heavy = TruckProfile(load_lb=50_000, departure=TRUCK.departure)
    with pytest.raises(NoRouteError):
        TomTomRouter("key").routes(ORIGIN, DEST, heavy, alternatives=0)
    assert mock.calls.last.request.url.params["vehicleWeight"] == str(round(80_000 * 0.45359237))


# --- Open-Meteo ------------------------------------------------------------------


def om_location(n_hours, start):
    return {
        "hourly": {
            "time": [start + 3600 * h for h in range(n_hours)],
            "wind_speed_10m": [10.0] * n_hours,
            "wind_gusts_10m": [15.0] * n_hours,
            "rain": [0.1] * n_hours,
            "showers": [0.05] * n_hours,
            "snowfall": [0.0] * n_hours,
            "temperature_2m": [40.0] * n_hours,
            "weather_code": [61] * n_hours,
        }
    }


@respx.mock
def test_open_meteo_dedupes_snaps_batches_and_caches():
    start = datetime(2026, 10, 10, 14, tzinfo=UTC)
    end = datetime(2026, 10, 10, 16, tzinfo=UTC)
    t0 = int(start.timestamp())

    def reply(request):
        n = len(request.url.params["latitude"].split(","))
        body = [om_location(3, t0) for _ in range(n)]
        return httpx.Response(200, json=body if n > 1 else body[0])

    route = respx.get(FREE_URL).mock(side_effect=reply)
    # Two points share a 0.05 degree cell; 150 distinct cells need two batches.
    points = [(40.001, -100.001), (40.004, -99.999)] + [(41 + k * 0.1, -90.0) for k in range(150)]
    result = OpenMeteoClient(api_key="").hourly(points, start, end)
    assert len(result) == 151
    assert route.call_count == 2
    s = result[snap((40.001, -100.001))]
    assert s.rain_in[0] == pytest.approx(0.15)  # rain + showers
    params = route.calls[0].request.url.params
    assert params["wind_speed_unit"] == "mph" and params["precipitation_unit"] == "inch"
    assert params["start_hour"] == "2026-10-10T14:00"

    OpenMeteoClient(api_key="").hourly(points[:5], start, end)
    assert route.call_count == 2  # served from cache


@respx.mock
def test_open_meteo_rain_and_showers_sum_exactly():
    start = datetime(2026, 10, 10, 14, tzinfo=UTC)
    body = om_location(1, int(start.timestamp()))
    body["hourly"]["rain"], body["hourly"]["showers"] = [0.09], [0.01]
    respx.get(FREE_URL).mock(return_value=httpx.Response(200, json=body))
    series = OpenMeteoClient(api_key="").hourly([(40, -100)], start, start)[snap((40, -100))]
    assert series.rain_in[0] == 0.10  # not 0.09999999999999999, which would classify as Low


@respx.mock
def test_optional_locations_may_fail_without_losing_required_ones():
    start = datetime(2026, 10, 10, 14, tzinfo=UTC)
    t0 = int(start.timestamp())

    def reply(request):
        lats = request.url.params["latitude"].split(",")
        if lats[0].startswith("45"):  # the optional batch
            return httpx.Response(429, json={"reason": "limit"})
        body = [om_location(1, t0) for _ in lats]
        return httpx.Response(200, json=body if len(lats) > 1 else body[0])

    respx.get(FREE_URL).mock(side_effect=reply)
    required, optional = [(40, -100), (41, -100)], [(45, -90)]
    result, error = OpenMeteoClient(api_key="").hourly_prioritized(required, optional, start, start)
    assert isinstance(error, RateLimitedError)
    assert set(result) == {snap(p) for p in required}

    respx.get(FREE_URL).mock(return_value=httpx.Response(429, json={"reason": "limit"}))
    cache.clear()
    with pytest.raises(RateLimitedError):
        OpenMeteoClient(api_key="").hourly_prioritized(required, optional, start, start)


@respx.mock
def test_open_meteo_rate_limit_is_reported():
    respx.get(FREE_URL).mock(return_value=httpx.Response(429, json={"reason": "limit"}))
    start = datetime(2026, 10, 10, 14, tzinfo=UTC)
    with pytest.raises(RateLimitedError):
        OpenMeteoClient(api_key="").hourly([(40, -100)], start, start)


# --- Alternatives ----------------------------------------------------------------


def test_trim_spurs_removes_an_out_and_back_detour():
    # East along y=40, a 5 km detour north and back on a parallel road ~50 m away, then east.
    east = [(40.0, -100.0 + 0.001 * i) for i in range(100)]
    north = [(40.0 + 0.0005 * i, -99.9) for i in range(1, 90)]
    back = [(40.0 + 0.0005 * i, -99.8995) for i in range(89, 0, -1)]
    rest = [(40.0, -99.8995 + 0.001 * i) for i in range(1, 100)]
    coords = east + north + back + rest
    cum = cumulative_distances(coords)
    path = RoutePath(coords=coords, cum_distance_m=cum, cum_time_s=[d / 25 for d in cum])
    trimmed = trim_spurs(path)
    assert trimmed.distance_m < path.distance_m - 9_000
    assert max(lat for lat, _ in trimmed.coords) < 40.001


def test_trim_spurs_leaves_normal_routes_alone():
    route = straight_route(miles=50, hours=1)
    assert trim_spurs(route) is route


def test_shared_fraction():
    a = straight_route(miles=60, hours=1)
    far = straight_route(miles=60, hours=1, lat=41.0)
    assert shared_fraction(a, a) == pytest.approx(1.0)
    assert shared_fraction(a, far) == 0.0


@respx.mock
def test_connection_failures_explain_what_happened():
    respx.get(url__startswith="https://router.project-osrm.org/").mock(
        side_effect=httpx.ConnectError("Name or service not known")
    )
    with pytest.raises(ProviderError) as exc:
        OsrmRouter().routes(ORIGIN, DEST, TRUCK, alternatives=2)
    assert str(exc.value).startswith("Couldn't reach the OSRM routing service.")
    assert exc.value.status_code == 502


@respx.mock
def test_place_search_uses_a_short_timeout():
    route = respx.get(url__startswith="https://photon.komoot.io/").mock(
        return_value=httpx.Response(200, json={"features": []})
    )
    assert PhotonGeocoder("US,CA").search("Dhaka") == []
    assert route.calls.last.request.extensions["timeout"]["read"] == 6
