"""Summarise each route's weather exposure and pick the recommended route.

Ranking is lexicographic, in the order the assessment specifies:

    0. Fewest No Travel miles (added: a No Travel stretch is worse than Severe, and
       the spec's list doesn't mention it, so it ranks ahead of everything else)
    1. Fewest Severe miles
    2. Fewest High miles
    3. Lowest average risk (mile-weighted mean of Low=0 ... No Travel=4)
    4. Shortest travel time

Miles are compared at 0.1 mi and average risk at 0.01, so floating-point noise
can't decide between two routes that are effectively equal. In calm weather every
risk criterion ties and the fastest route wins.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .risk import RiskLevel


@dataclass(frozen=True)
class Exposure:
    miles: dict[RiskLevel, float]
    avg_risk: float
    max_level: RiskLevel
    duration_s: float

    @property
    def total_miles(self) -> float:
        return sum(self.miles.values())


def exposure(
    levels: Sequence[RiskLevel], covered_miles: Sequence[float], duration_s: float
) -> Exposure:
    miles = dict.fromkeys(RiskLevel, 0.0)
    for level, distance in zip(levels, covered_miles, strict=True):
        miles[level] += distance
    total = sum(covered_miles)
    avg = (
        sum(level * d for level, d in zip(levels, covered_miles, strict=True)) / total
        if total
        else 0.0
    )
    return Exposure(
        miles=miles,
        avg_risk=avg,
        max_level=max(levels, default=RiskLevel.LOW),
        duration_s=duration_s,
    )


@dataclass(frozen=True)
class Criterion:
    key: str
    value: Callable[[Exposure], float]


CRITERIA: tuple[Criterion, ...] = (
    Criterion("no_travel_miles", lambda e: round(e.miles[RiskLevel.NO_TRAVEL], 1)),
    Criterion("severe_miles", lambda e: round(e.miles[RiskLevel.SEVERE], 1)),
    Criterion("high_miles", lambda e: round(e.miles[RiskLevel.HIGH], 1)),
    Criterion("avg_risk", lambda e: round(e.avg_risk, 2)),
    Criterion("duration_s", lambda e: round(e.duration_s)),
)


def rank_key(e: Exposure) -> tuple[float, ...]:
    return tuple(c.value(e) for c in CRITERIA)


@dataclass(frozen=True)
class Comparison:
    """Why the recommended route beats `other`: the first criterion that differs."""

    other: int
    criterion: str | None  # None when the two routes tie on every criterion
    best_value: float | None
    other_value: float | None


@dataclass(frozen=True)
class Recommendation:
    best: int
    order: list[int]  # route indices, best first
    comparisons: list[Comparison]
    all_routes_blocked: bool  # every route crosses No Travel conditions


def recommend(exposures: Sequence[Exposure]) -> Recommendation:
    if not exposures:
        raise ValueError("no routes to rank")
    keys = [rank_key(e) for e in exposures]
    # sorted() is stable, so exact ties keep the provider's order (fastest first).
    order = sorted(range(len(exposures)), key=lambda i: keys[i])
    best = order[0]
    comparisons = []
    for other in order[1:]:
        for c, best_value, other_value in zip(CRITERIA, keys[best], keys[other], strict=True):
            if best_value != other_value:
                comparisons.append(Comparison(other, c.key, best_value, other_value))
                break
        else:
            comparisons.append(Comparison(other, None, None, None))
    blocked = all(e.miles[RiskLevel.NO_TRAVEL] > 0 for e in exposures)
    return Recommendation(
        best=best, order=order, comparisons=comparisons, all_routes_blocked=blocked
    )
