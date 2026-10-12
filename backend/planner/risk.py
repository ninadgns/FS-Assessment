"""Weather risk classification, implementing the assessment's risk and load rules.

Threshold table (per checkpoint):

    Condition  Low          Moderate    High        Severe      No Travel
    Wind       <25 mph      25-34       35-44       45-54       >=55 mph
    Rain       <0.10 in/hr  0.10-0.25   0.25-0.50   0.50-1.00   >1.00
    Snow       <0.5 in/hr   0.5-1.0     1.0-2.0     2.0-3.0     >3.0

Load rules (wind only):
    >=55 mph                      -> No Travel for any load
    45-54 mph and load >30,000 lb -> No Travel
    35-44 mph and load >40,000 lb -> Severe

Boundary handling: each band includes its lower bound and excludes its upper bound
(so 25.0 mph is Moderate and 34.9 mph is Moderate), except where the table writes
the top band as a strict ">": rain of exactly 1.00 in/hr and snow of exactly
3.0 in/hr are still Severe. Wind uses sustained 10 m wind speed; gusts are reported
but not classified.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum


class RiskLevel(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4

    @property
    def label(self) -> str:
        return {
            RiskLevel.LOW: "Low",
            RiskLevel.MODERATE: "Moderate",
            RiskLevel.HIGH: "High",
            RiskLevel.SEVERE: "Severe",
            RiskLevel.NO_TRAVEL: "No Travel",
        }[self]

    @property
    def key(self) -> str:
        return self.name.lower()


@dataclass(frozen=True)
class Thresholds:
    """Lower bounds of the Moderate, High, Severe and No Travel bands."""

    moderate: float
    high: float
    severe: float
    no_travel: float
    # True when the No Travel band is a strict ">" (value must exceed `no_travel`).
    no_travel_exclusive: bool

    def level(self, value: float) -> RiskLevel:
        if value > self.no_travel or (value == self.no_travel and not self.no_travel_exclusive):
            return RiskLevel.NO_TRAVEL
        if value >= self.severe:
            return RiskLevel.SEVERE
        if value >= self.high:
            return RiskLevel.HIGH
        if value >= self.moderate:
            return RiskLevel.MODERATE
        return RiskLevel.LOW

    def band(self, level: RiskLevel) -> tuple[float, float]:
        """(lower, upper) value range of a level below No Travel."""
        edges = (0.0, self.moderate, self.high, self.severe, self.no_travel)
        return edges[level], edges[level + 1]


WIND_MPH = Thresholds(moderate=25, high=35, severe=45, no_travel=55, no_travel_exclusive=False)
RAIN_IN_HR = Thresholds(
    moderate=0.10, high=0.25, severe=0.50, no_travel=1.00, no_travel_exclusive=True
)
SNOW_IN_HR = Thresholds(moderate=0.5, high=1.0, severe=2.0, no_travel=3.0, no_travel_exclusive=True)

HEAVY_LOAD_NO_TRAVEL_LB = 30_000  # 45-54 mph wind with a load above this -> No Travel
HEAVY_LOAD_SEVERE_LB = 40_000  # 35-44 mph wind with a load above this -> Severe


@dataclass(frozen=True)
class Conditions:
    """Weather at one place and time, in the units the risk table uses."""

    wind_mph: float
    rain_in_hr: float
    snow_in_hr: float


@dataclass(frozen=True)
class Factor:
    condition: str  # "wind" | "rain" | "snow"
    level: RiskLevel
    value: float
    load_adjusted: bool = False


@dataclass(frozen=True)
class RiskAssessment:
    level: RiskLevel
    factors: tuple[Factor, ...]  # every condition, highest level first

    @property
    def drivers(self) -> tuple[Factor, ...]:
        """The conditions responsible for the overall level (empty when Low)."""
        if self.level == RiskLevel.LOW:
            return ()
        return tuple(f for f in self.factors if f.level == self.level)


def wind_level(wind_mph: float, load_lb: float) -> tuple[RiskLevel, bool]:
    """Wind level after load rules, plus whether the load raised it."""
    base = WIND_MPH.level(wind_mph)
    if base == RiskLevel.SEVERE and load_lb > HEAVY_LOAD_NO_TRAVEL_LB:
        return RiskLevel.NO_TRAVEL, True
    if base == RiskLevel.HIGH and load_lb > HEAVY_LOAD_SEVERE_LB:
        return RiskLevel.SEVERE, True
    return base, False


def assess(conditions: Conditions, load_lb: float) -> RiskAssessment:
    """Overall risk is the worst of the wind (load-adjusted), rain and snow levels."""
    wind, adjusted = wind_level(conditions.wind_mph, load_lb)
    factors = [
        Factor("wind", wind, conditions.wind_mph, load_adjusted=adjusted),
        Factor("rain", RAIN_IN_HR.level(conditions.rain_in_hr), conditions.rain_in_hr),
        Factor("snow", SNOW_IN_HR.level(conditions.snow_in_hr), conditions.snow_in_hr),
    ]
    factors.sort(key=lambda f: f.level, reverse=True)  # stable: wind wins ties
    return RiskAssessment(level=factors[0].level, factors=tuple(factors))


def _continuous(value: float, thresholds: Thresholds, level: RiskLevel, base: RiskLevel) -> float:
    """Place `value` inside its level's band so the heatmap varies smoothly between
    thresholds. `base` is the unadjusted table level whose band `value` falls in.
    The result always floors to `level`, so the heatmap and checkpoints agree."""
    if level == RiskLevel.NO_TRAVEL:
        return float(RiskLevel.NO_TRAVEL)
    lower, upper = thresholds.band(base)
    fraction = (value - lower) / (upper - lower) if upper > lower else 0.0
    return level + min(max(fraction, 0.0), 0.999)


def risk_index(conditions: Conditions, load_lb: float) -> float:
    """Continuous 0-4 risk score for the corridor heatmap (floor == discrete level)."""
    wind, _ = wind_level(conditions.wind_mph, load_lb)
    rain = RAIN_IN_HR.level(conditions.rain_in_hr)
    snow = SNOW_IN_HR.level(conditions.snow_in_hr)
    return max(
        _continuous(conditions.wind_mph, WIND_MPH, wind, WIND_MPH.level(conditions.wind_mph)),
        _continuous(conditions.rain_in_hr, RAIN_IN_HR, rain, rain),
        _continuous(conditions.snow_in_hr, SNOW_IN_HR, snow, snow),
    )
