"""Synthetic routes and forecasts for tests."""

from planner.geo import METERS_PER_MILE, cumulative_distances
from planner.providers.base import RoutePath
from planner.providers.openmeteo import HourlySeries


def straight_route(
    miles: float, hours: float, lat: float = 40.0, lon0: float = -100.0, points: int = 200
) -> RoutePath:
    """An eastbound route along a parallel, driven at constant speed."""
    total_m = miles * METERS_PER_MILE
    # Degrees of longitude per metre at this latitude (approximate, then rescaled).
    coords = [(lat, lon0 + k / (points - 1)) for k in range(points)]
    geo = cumulative_distances(coords)
    scale = total_m / geo[-1]
    coords = [(lat, lon0 + (c[1] - lon0) * scale) for c in coords]
    cum_d = cumulative_distances(coords)
    cum_t = [d / cum_d[-1] * hours * 3600 for d in cum_d]
    return RoutePath(coords=coords, cum_distance_m=cum_d, cum_time_s=cum_t, roads=["I-70"])


def series(
    start: int,
    hours: int,
    *,
    wind=5.0,
    gust=10.0,
    rain=0.0,
    snow=0.0,
    temp=50.0,
    code=0,
    overrides: dict | None = None,
) -> HourlySeries:
    """Constant forecast, optionally overriding variables per hour index:
    overrides={"wind_mph": {3: 40.0}}."""
    base = {
        "wind_mph": [wind] * hours,
        "gust_mph": [gust] * hours,
        "rain_in": [rain] * hours,
        "snow_in": [snow] * hours,
        "temp_f": [temp] * hours,
        "weather_code": [code] * hours,
    }
    for name, by_hour in (overrides or {}).items():
        for i, value in by_hour.items():
            base[name][i] = value
    return HourlySeries(
        times=tuple(start + h * 3600 for h in range(hours)),
        **{k: tuple(v) for k, v in base.items()},
    )
