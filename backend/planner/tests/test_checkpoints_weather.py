from datetime import UTC, datetime, timedelta

import pytest

from planner.checkpoints import checkpoint_distances, sample_checkpoints
from planner.geo import METERS_PER_MILE
from planner.weather import sample_at

from .factories import series, straight_route

MI = METERS_PER_MILE
DEPARTURE = datetime(2026, 10, 10, 14, 0, tzinfo=UTC)


def miles(values):
    return [round(v / MI, 3) for v in values]


@pytest.mark.parametrize(
    ("total", "interval", "expected"),
    [
        (100, 25, [0, 25, 50, 75, 100]),  # exact multiple: destination is the last mark
        (110, 25, [0, 25, 50, 75, 100, 110]),  # remainder becomes its own checkpoint
        (100.3, 25, [0, 25, 50, 75, 100.3]),  # tiny remainder merges into the last mark
        (8, 10, [0, 8]),  # shorter than one interval: origin and destination
    ],
)
def test_checkpoint_distances(total, interval, expected):
    assert miles(checkpoint_distances(total * MI, interval * MI)) == pytest.approx(expected)


@pytest.mark.parametrize("interval", [10, 25, 50])
def test_checkpoints_cover_the_route_exactly_once(interval):
    route = straight_route(miles=237, hours=4)
    cps = sample_checkpoints(route, DEPARTURE, interval * MI)
    assert sum(c.covered_miles for c in cps) == pytest.approx(237, abs=0.01)
    for a, b in zip(cps, cps[1:], strict=False):
        assert a.covers_to_m == pytest.approx(b.covers_from_m)
        assert b.eta > a.eta


def test_checkpoint_eta_and_position_follow_the_route():
    route = straight_route(miles=100, hours=2)  # constant 50 mph
    cps = sample_checkpoints(route, DEPARTURE, 25 * MI)
    expected = [(DEPARTURE + timedelta(minutes=30 * k)).timestamp() for k in range(5)]
    assert [c.eta.timestamp() for c in cps] == pytest.approx(expected)
    assert cps[0].lon == pytest.approx(route.coords[0][1])
    assert cps[-1].lon == pytest.approx(route.coords[-1][1])
    assert cps[2].lon == pytest.approx((route.coords[0][1] + route.coords[-1][1]) / 2, abs=1e-3)


START = int(DEPARTURE.timestamp())


def test_instantaneous_values_interpolate_between_hours():
    s = series(START, 4, overrides={"wind_mph": {0: 20.0, 1: 40.0}, "temp_f": {0: 30.0, 1: 40.0}})
    sample = sample_at(s, DEPARTURE + timedelta(minutes=15))
    assert sample.wind_mph == pytest.approx(25.0)
    assert sample.temp_f == pytest.approx(32.5)


def test_hourly_totals_use_the_interval_containing_the_eta():
    # Open-Meteo stores the 14:00-15:00 total at 15:00 (index 1).
    s = series(START, 4, overrides={"rain_in": {0: 0.9, 1: 0.3, 2: 0.0}, "snow_in": {1: 1.5}})
    at_1420 = sample_at(s, DEPARTURE + timedelta(minutes=20))
    assert at_1420.rain_in_hr == pytest.approx(0.3)
    assert at_1420.snow_in_hr == pytest.approx(1.5)
    # Exactly on the hour, the interval ending now applies.
    assert sample_at(s, DEPARTURE).rain_in_hr == pytest.approx(0.9)


def test_missing_values_fall_back_gracefully():
    s = series(START, 3, overrides={"wind_mph": {1: None}, "rain_in": {1: None}})
    sample = sample_at(s, DEPARTURE + timedelta(minutes=30))
    assert sample.wind_mph == pytest.approx(5.0)  # uses the hour that has data
    assert sample.rain_in_hr == 0.0


def test_sampling_outside_the_window_raises():
    with pytest.raises(ValueError):
        sample_at(series(START, 3), DEPARTURE + timedelta(hours=10))
