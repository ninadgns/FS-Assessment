from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from planner import service
from planner.geo import LatLon
from planner.providers.base import Place, ProviderError, RateLimitedError, RoutePath, TruckProfile
from planner.providers.openmeteo import snap

from .factories import series, straight_route


class FakeRouter:
    name = "fake"

    def routes(
        self, origin, destination, truck: TruckProfile, alternatives: int
    ) -> list[RoutePath]:
        # B is slower but stays clear of the storm placed on A's latitude.
        return [
            straight_route(300, 5, lat=40.0),
            straight_route(320, 6, lat=40.6),
            straight_route(340, 7, lat=39.4),
        ]

    def route_through(self, points: list[LatLon], truck: TruckProfile) -> RoutePath:
        raise ProviderError("not used")


class FakeWeather:
    """Calm everywhere except 50 mph wind on latitude 40.0 (route A)."""

    def hourly_prioritized(self, required, optional, start, end):
        forecasts = self.hourly(required, start, end)
        try:
            forecasts.update(self.hourly(optional, start, end))
        except ProviderError as exc:
            return forecasts, exc
        return forecasts, None

    def hourly(self, points, start, end):
        t0 = int(start.timestamp()) // 3600 * 3600
        hours = int((end - start).total_seconds() // 3600) + 3
        out = {}
        for p in points:
            cell = snap(p)
            out[cell] = series(t0, hours, wind=50.0 if abs(cell[0] - 40.0) < 0.25 else 8.0)
        return out


class FakeGeocoder:
    name = "fake"

    def search(self, query, limit=5):
        return [Place("Denver", 39.74, -104.99, "Colorado, US")] if "den" in query.lower() else []


@pytest.fixture
def client(monkeypatch):
    cache.clear()
    monkeypatch.setattr(service, "get_router", FakeRouter)
    monkeypatch.setattr(service, "OpenMeteoClient", FakeWeather)
    monkeypatch.setattr("planner.views.get_geocoder", FakeGeocoder)
    return APIClient()


def payload(**overrides):
    body = {
        "origin": {"label": "Origin", "lat": 40.0, "lon": -100.0},
        "destination": {"label": "Destination", "lat": 40.0, "lon": -94.0},
        "departure_time": (timezone.now() + timedelta(hours=1)).isoformat(),
        "load_weight_lb": 35_000,
        "sample_interval_mi": 25,
    }
    body.update(overrides)
    return body


def test_plan_ranks_routes_and_returns_map_data(client):
    response = client.post("/api/plan", payload(), format="json")
    assert response.status_code == 200, response.content
    data = response.json()
    routes = {r["id"]: r for r in data["routes"]}

    # 50 mph wind with a 35,000 lb load is No Travel on A, so the slower B wins.
    assert routes["A"]["exposure"]["miles"]["no_travel"] == pytest.approx(300, abs=0.2)
    assert data["recommendation"]["route"] == "B"
    assert data["recommendation"]["ranking"] == ["B", "C", "A"]
    assert data["recommendation"]["comparisons"][0] == {
        "route": "C",
        "criterion": "duration_s",
        "recommended_value": 6 * 3600,
        "other_value": 7 * 3600,
    }
    assert routes["B"]["recommended"] and routes["B"]["rank"] == 1

    a_cp = routes["A"]["checkpoints"][3]
    assert a_cp["risk"]["label"] == "No Travel"
    assert a_cp["risk"]["drivers"] == ["wind"]
    assert a_cp["risk"]["factors"][0]["load_adjusted"] is True
    assert len(routes["A"]["checkpoints"]) == 13  # 0, 25, ... 300

    heatmap = data["heatmap"]
    assert len(heatmap["times"]) == 50
    assert len(heatmap["layers"]["risk"][0]) == len(heatmap["cols"]) == len(heatmap["opacity"])
    assert max(heatmap["layers"]["risk"][0]) == 4.0


def test_plan_geocodes_free_text_places(client):
    body = payload(destination={"label": "Denver, CO"})
    response = client.post("/api/plan", body, format="json")
    assert response.status_code == 200
    assert response.json()["request"]["destination"]["detail"] == "Colorado, US"


@pytest.mark.parametrize(
    ("overrides", "field"),
    [
        ({"load_weight_lb": 50_001}, "load_weight_lb"),
        ({"sample_interval_mi": 15}, "sample_interval_mi"),
        ({"departure_time": (timezone.now() - timedelta(hours=3)).isoformat()}, "departure_time"),
        ({"departure_time": (timezone.now() + timedelta(days=9)).isoformat()}, "departure_time"),
        ({"destination": {"label": "Nowhere"}}, "destination"),
        ({"destination": {"label": "Same", "lat": 40.0, "lon": -100.0}}, "destination"),
    ],
)
def test_plan_validation_errors(client, overrides, field):
    response = client.post("/api/plan", payload(**overrides), format="json")
    assert response.status_code == 400
    assert field in response.json()


def test_provider_errors_become_json_responses(client, monkeypatch):
    class Broken(FakeRouter):
        def routes(self, *args, **kwargs):
            raise ProviderError("OSRM is unreachable")

    monkeypatch.setattr(service, "get_router", Broken)
    response = client.post("/api/plan", payload(), format="json")
    assert response.status_code == 502
    assert response.json() == {"detail": "OSRM is unreachable"}


def test_geocode_endpoint(client):
    assert client.get("/api/geocode?q=d").json() == {"results": []}
    results = client.get("/api/geocode?q=denver").json()["results"]
    assert results[0]["label"] == "Denver"


def test_too_many_weather_samples_is_a_clear_error(client, settings):
    settings.PLANNER = {**settings.PLANNER, "WEATHER_LOCATION_LIMIT": 100}
    response = client.post("/api/plan", payload(sample_interval_mi=10), format="json")
    assert response.status_code == 422
    assert "longer interval" in response.json()["detail"]


def test_heatmap_failure_degrades_instead_of_failing(client, monkeypatch):
    class GridRateLimited(FakeWeather):
        calls = 0

        def hourly(self, points, start, end):
            # The first call is the checkpoints; the grid call hits the rate limit.
            if len(points) > 200 or GridRateLimited.calls:
                raise RateLimitedError("Open-Meteo rate limit reached")
            GridRateLimited.calls += 1
            return super().hourly(points, start, end)

    monkeypatch.setattr(service, "OpenMeteoClient", GridRateLimited)
    response = client.post("/api/plan", payload(sample_interval_mi=50), format="json")
    assert response.status_code == 200
    data = response.json()
    assert data["heatmap"] is None
    assert "heatmap is unavailable" in data["warnings"][0]
    assert data["recommendation"]["route"] == "B"


def test_checkpoint_weather_failure_fails_the_plan(client, monkeypatch):
    class Down(FakeWeather):
        def hourly(self, points, start, end):
            raise RateLimitedError("Open-Meteo rate limit reached, try again in a minute")

    monkeypatch.setattr(service, "OpenMeteoClient", Down)
    response = client.post("/api/plan", payload(), format="json")
    assert response.status_code == 503


def test_empty_route_list_is_a_clear_error(client, monkeypatch):
    class Nothing(FakeRouter):
        def routes(self, *args, **kwargs):
            return []

    monkeypatch.setattr(service, "get_router", Nothing)
    response = client.post("/api/plan", payload(), format="json")
    assert response.status_code == 422


def test_heatmap_risk_never_rounds_up_into_the_next_level(client, monkeypatch):
    class JustBelow(FakeWeather):
        def hourly(self, points, start, end):
            t0 = int(start.timestamp()) // 3600 * 3600
            hours = int((end - start).total_seconds() // 3600) + 3
            return {snap(p): series(t0, hours, wind=24.99) for p in points}

    monkeypatch.setattr(service, "OpenMeteoClient", JustBelow)
    data = client.post("/api/plan", payload(), format="json").json()
    assert max(data["heatmap"]["layers"]["risk"][0]) < 1.0  # still Low, like the checkpoints
