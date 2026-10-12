import math

import pytest

from planner.risk import Conditions, RiskLevel, assess, risk_index, wind_level

L, M, H, S, NT = (
    RiskLevel.LOW,
    RiskLevel.MODERATE,
    RiskLevel.HIGH,
    RiskLevel.SEVERE,
    RiskLevel.NO_TRAVEL,
)
LIGHT = 10_000  # below both load thresholds


def level(wind=0.0, rain=0.0, snow=0.0, load=LIGHT) -> RiskLevel:
    return assess(Conditions(wind, rain, snow), load).level


@pytest.mark.parametrize(
    ("wind", "expected"),
    [
        (0, L),
        (24.9, L),
        (25, M),
        (34.9, M),
        (35, H),
        (44.9, H),
        (45, S),
        (54.9, S),
        (55, NT),
        (80, NT),
    ],
)
def test_wind_thresholds(wind, expected):
    assert level(wind=wind) == expected


@pytest.mark.parametrize(
    ("rain", "expected"),
    [(0.09, L), (0.10, M), (0.24, M), (0.25, H), (0.49, H), (0.50, S), (1.00, S), (1.01, NT)],
)
def test_rain_thresholds(rain, expected):
    assert level(rain=rain) == expected


@pytest.mark.parametrize(
    ("snow", "expected"),
    [(0.4, L), (0.5, M), (0.99, M), (1.0, H), (1.99, H), (2.0, S), (3.0, S), (3.1, NT)],
)
def test_snow_thresholds(snow, expected):
    assert level(snow=snow) == expected


@pytest.mark.parametrize(
    ("wind", "load", "expected", "adjusted"),
    [
        (55, 0, NT, False),  # >=55 mph is No Travel for any load
        (50, 30_000, S, False),  # 45-54 needs a load strictly above 30,000 lb
        (50, 30_001, NT, True),
        (45, 45_000, NT, True),
        (40, 40_000, H, False),  # 35-44 needs a load strictly above 40,000 lb
        (40, 40_001, S, True),
        (35, 80_000, S, True),
        (34.9, 80_000, M, False),  # below 35 mph the load doesn't matter
    ],
)
def test_load_rules(wind, load, expected, adjusted):
    assert wind_level(wind, load) == (expected, adjusted)
    assert level(wind=wind, load=load) == expected


def test_overall_level_is_worst_condition_and_reports_drivers():
    result = assess(Conditions(wind_mph=30, rain_in_hr=0.6, snow_in_hr=1.2), load_lb=LIGHT)
    assert result.level == S
    assert [f.condition for f in result.drivers] == ["rain"]
    assert [f.condition for f in result.factors] == ["rain", "snow", "wind"]


def test_ties_list_every_driver_and_low_has_none():
    tied = assess(Conditions(wind_mph=36, rain_in_hr=0.3, snow_in_hr=0), load_lb=LIGHT)
    assert tied.level == H
    assert {f.condition for f in tied.drivers} == {"wind", "rain"}
    assert assess(Conditions(5, 0, 0), LIGHT).drivers == ()


@pytest.mark.parametrize(
    "conditions",
    [
        Conditions(0, 0, 0),
        Conditions(24.99, 0, 0),
        Conditions(25, 0, 0),
        Conditions(40, 0, 0),
        Conditions(50, 0, 0),
        Conditions(70, 0, 0),
        Conditions(0, 0.25, 0),
        Conditions(0, 1.0, 0),
        Conditions(0, 2.0, 0),
        Conditions(0, 0, 2.5),
        Conditions(0, 0, 3.0),
        Conditions(30, 0.3, 1.5),
    ],
)
@pytest.mark.parametrize("load", [0, 35_000, 45_000])
def test_heatmap_index_floors_to_checkpoint_level(conditions, load):
    index = risk_index(conditions, load)
    assert 0 <= index <= 4
    assert math.floor(index) == assess(conditions, load).level


def test_heatmap_index_is_monotonic_within_a_band():
    values = [risk_index(Conditions(w, 0, 0), LIGHT) for w in (25, 28, 31, 34)]
    assert values == sorted(values)
    assert values[0] == pytest.approx(1.0)
