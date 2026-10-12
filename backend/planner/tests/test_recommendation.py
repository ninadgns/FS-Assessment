import pytest

from planner.recommendation import exposure, recommend
from planner.risk import RiskLevel

L, M, H, S, NT = (
    RiskLevel.LOW,
    RiskLevel.MODERATE,
    RiskLevel.HIGH,
    RiskLevel.SEVERE,
    RiskLevel.NO_TRAVEL,
)


def route(levels, hours, miles_each=10.0):
    return exposure(levels, [miles_each] * len(levels), hours * 3600)


def test_exposure_totals_miles_and_mile_weighted_average():
    e = exposure([L, H, S], [10, 30, 10], duration_s=3600)
    assert e.miles[RiskLevel.HIGH] == 30
    assert e.total_miles == 50
    assert e.avg_risk == pytest.approx((0 * 10 + 2 * 30 + 3 * 10) / 50)
    assert e.max_level == S


@pytest.mark.parametrize(
    ("routes", "expected_best", "criterion"),
    [
        # 0: No Travel outranks everything, even a much slower detour
        ([route([NT, L, L], 10), route([S, S, S], 20)], 1, "no_travel_miles"),
        # 1: fewest Severe miles beats fewer High miles and speed
        ([route([S, L, L], 10), route([H, H, H], 15)], 1, "severe_miles"),
        # 2: then fewest High miles
        ([route([H, H, L], 10), route([H, M, M], 12)], 1, "high_miles"),
        # 3: then lowest average risk
        ([route([M, M, L], 10), route([M, L, L], 12)], 1, "avg_risk"),
        # 4: finally the shortest travel time
        ([route([L, L, L], 12), route([L, L, L], 10)], 1, "duration_s"),
    ],
)
def test_ranking_follows_the_priority_order(routes, expected_best, criterion):
    rec = recommend(routes)
    assert rec.best == expected_best
    assert rec.comparisons[0].criterion == criterion


def test_severe_miles_are_compared_as_distance_not_checkpoint_count():
    short_severe = exposure([S, L], [5, 95], 10 * 3600)
    long_severe = exposure([S, L], [20, 80], 9 * 3600)
    assert recommend([long_severe, short_severe]).best == 1


def test_exact_ties_keep_provider_order():
    rec = recommend([route([L, L], 10), route([L, L], 10)])
    assert rec.order == [0, 1]
    assert rec.comparisons[0].criterion is None


def test_tiny_float_differences_do_not_decide():
    a = exposure([M, L], [10.0, 90.0], 10 * 3600)
    b = exposure([M, L], [10.0001, 89.9999], 9 * 3600)
    assert recommend([a, b]).comparisons[0].criterion == "duration_s"


def test_flags_when_every_route_hits_no_travel():
    assert recommend([route([NT], 1), route([NT, L], 2)]).all_routes_blocked
    assert not recommend([route([NT], 1), route([S], 2)]).all_routes_blocked
