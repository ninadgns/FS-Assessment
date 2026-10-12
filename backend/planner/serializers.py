"""Request validation and response shaping for the planner API."""

from __future__ import annotations

from datetime import timedelta

from django.utils import timezone
from rest_framework import serializers

from .geo import METERS_PER_MILE, haversine_m, mercator_array, simplify_indices
from .providers.base import Geocoder, Place
from .risk import RiskLevel
from .service import AssessedCheckpoint, Heatmap, RoutePlan, TripPlan, TripRequest

SAMPLE_INTERVALS_MI = (10, 25, 50)
# Cargo weight. A loaded 5-axle rig is held to 80,000 lb gross, i.e. roughly 45,000 lb of
# cargo; 50,000 leaves headroom for light tractors while rejecting impossible loads.
MAX_LOAD_LB = 50_000
MAX_DEPARTURE_AHEAD = timedelta(days=7)  # keeps arrival inside the 16-day forecast
MAX_DEPARTURE_BEHIND = timedelta(hours=1)


class PlaceSerializer(serializers.Serializer):
    label = serializers.CharField(max_length=200)
    lat = serializers.FloatField(min_value=-90, max_value=90, required=False, allow_null=True)
    lon = serializers.FloatField(min_value=-180, max_value=180, required=False, allow_null=True)

    def validate(self, attrs):
        if (attrs.get("lat") is None) != (attrs.get("lon") is None):
            raise serializers.ValidationError("Provide both lat and lon, or neither.")
        return attrs


class PlanRequestSerializer(serializers.Serializer):
    origin = PlaceSerializer()
    destination = PlaceSerializer()
    departure_time = serializers.DateTimeField(required=False)
    load_weight_lb = serializers.IntegerField(min_value=0, max_value=MAX_LOAD_LB)
    sample_interval_mi = serializers.ChoiceField(choices=SAMPLE_INTERVALS_MI, default=25)

    def validate_departure_time(self, value):
        now = timezone.now()
        if value < now - MAX_DEPARTURE_BEHIND:
            raise serializers.ValidationError("Departure can't be in the past.")
        if value > now + MAX_DEPARTURE_AHEAD:
            raise serializers.ValidationError("Departure must be within the next 7 days.")
        return value

    def to_trip_request(self, geocoder: Geocoder) -> TripRequest:
        data = self.validated_data
        origin = _resolve(data["origin"], geocoder, "origin")
        destination = _resolve(data["destination"], geocoder, "destination")
        if haversine_m(origin.latlon, destination.latlon) < 1_000:
            raise serializers.ValidationError(
                {"destination": "Origin and destination are the same place."}
            )
        return TripRequest(
            origin=origin,
            destination=destination,
            departure=data.get("departure_time") or timezone.now(),
            load_lb=data["load_weight_lb"],
            interval_mi=int(data["sample_interval_mi"]),
        )


def _resolve(place: dict, geocoder: Geocoder, field: str) -> Place:
    if place.get("lat") is not None:
        return Place(label=place["label"], lat=place["lat"], lon=place["lon"])
    matches = geocoder.search(place["label"], limit=1)
    if not matches:
        raise serializers.ValidationError({field: f"Couldn't find “{place['label']}”."})
    return matches[0]


# --- Response shaping ------------------------------------------------------------


def _iso(dt) -> str:
    return dt.isoformat(timespec="seconds")


def _miles(meters: float, digits: int = 1) -> float:
    return round(meters / METERS_PER_MILE, digits)


def place_dict(place: Place) -> dict:
    return {"label": place.label, "detail": place.detail, "lat": place.lat, "lon": place.lon}


def _geometry(route: RoutePlan) -> dict:
    """Simplified line for the map, keeping per-vertex elapsed time and mileage so the
    frontend can place the truck at any moment and colour stretches by risk."""
    path = route.path
    xy = mercator_array(path.coords)
    tolerance = max(25.0, path.distance_m / 20_000)  # ~1-2k vertices on a long haul
    keep = simplify_indices(xy, tolerance)
    return {
        "coordinates": [[round(path.coords[i][1], 5), round(path.coords[i][0], 5)] for i in keep],
        "elapsed_s": [round(path.cum_time_s[i]) for i in keep],
        "miles": [_miles(path.cum_distance_m[i], 2) for i in keep],
    }


def _checkpoint(a: AssessedCheckpoint, departure) -> dict:
    cp, w, risk = a.checkpoint, a.weather, a.risk
    return {
        "index": cp.index,
        "mile": _miles(cp.distance_m),
        "lat": round(cp.lat, 5),
        "lon": round(cp.lon, 5),
        "eta": _iso(cp.eta),
        "elapsed_s": round((cp.eta - departure).total_seconds()),
        "covers_miles": [_miles(cp.covers_from_m, 2), _miles(cp.covers_to_m, 2)],
        "weather": {
            "wind_mph": round(w.wind_mph, 1),
            "gust_mph": round(w.gust_mph, 1),
            "rain_in_hr": round(w.rain_in_hr, 3),
            "snow_in_hr": round(w.snow_in_hr, 2),
            "temp_f": None if w.temp_f is None else round(w.temp_f),
            "weather_code": w.weather_code,
        },
        "risk": {
            "level": int(risk.level),
            "label": risk.level.label,
            "drivers": [f.condition for f in risk.drivers],
            "factors": [
                {
                    "condition": f.condition,
                    "level": int(f.level),
                    "value": f.value,
                    "load_adjusted": f.load_adjusted,
                }
                for f in risk.factors
            ],
        },
    }


def _route(route: RoutePlan, plan: TripPlan, index: int) -> dict:
    departure = plan.request.departure
    rec = plan.recommendation
    e = route.exposure
    return {
        "id": route.name,
        "name": f"via {', '.join(route.path.roads[:2])}"
        if route.path.roads
        else f"Route {route.name}",
        "roads": route.path.roads[:3],
        "source": route.path.source,
        "distance_mi": _miles(route.path.distance_m),
        "duration_s": round(route.path.duration_s),
        "arrival_time": _iso(departure + timedelta(seconds=route.path.duration_s)),
        "rank": rec.order.index(index) + 1,
        "recommended": rec.best == index,
        "exposure": {
            "miles": {level.key: round(m, 1) for level, m in e.miles.items()},
            "avg_risk": round(e.avg_risk, 2),
            "max_level": int(e.max_level),
        },
        "geometry": _geometry(route),
        "checkpoints": [_checkpoint(a, departure) for a in route.checkpoints],
    }


def _heatmap(h: Heatmap) -> dict:
    g = h.grid
    return {
        "bounds": [round(v, 6) for v in g.bounds],
        "nx": g.nx,
        "ny": g.ny,
        "cell_km": round(g.cell_m / 1000, 1),
        "cols": g.cols,
        "rows": g.rows,
        "opacity": g.opacity,
        "times": h.times,
        "layers": h.layers,
    }


def plan_dict(plan: TripPlan) -> dict:
    req, rec = plan.request, plan.recommendation
    names = [r.name for r in plan.routes]
    return {
        "generated_at": _iso(timezone.now()),
        "provider": plan.provider,
        "request": {
            "origin": place_dict(req.origin),
            "destination": place_dict(req.destination),
            "departure_time": _iso(req.departure),
            "load_weight_lb": req.load_lb,
            "sample_interval_mi": req.interval_mi,
        },
        "routes": [_route(r, plan, i) for i, r in enumerate(plan.routes)],
        "recommendation": {
            "route": names[rec.best],
            "ranking": [names[i] for i in rec.order],
            "comparisons": [
                {
                    "route": names[c.other],
                    "criterion": c.criterion,
                    "recommended_value": c.best_value,
                    "other_value": c.other_value,
                }
                for c in rec.comparisons
            ],
            "all_routes_blocked": rec.all_routes_blocked,
        },
        "risk_levels": [
            {"level": int(level), "key": level.key, "label": level.label} for level in RiskLevel
        ],
        "heatmap": _heatmap(plan.heatmap) if plan.heatmap else None,
        "warnings": plan.warnings,
    }
