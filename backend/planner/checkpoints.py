"""Place weather checkpoints along a route at a fixed mileage interval."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .geo import METERS_PER_MILE, lerp, locate
from .providers.base import RoutePath

# If the destination is closer than this to the last regular checkpoint, the
# destination replaces that checkpoint instead of adding a near-duplicate.
MERGE_DISTANCE_M = 0.5 * METERS_PER_MILE


@dataclass(frozen=True)
class Checkpoint:
    index: int
    distance_m: float
    lat: float
    lon: float
    eta: datetime
    # Stretch of road this checkpoint's weather stands for: halfway to each neighbour.
    # Summing these over a route covers its full length exactly once.
    covers_from_m: float
    covers_to_m: float

    @property
    def covered_miles(self) -> float:
        return (self.covers_to_m - self.covers_from_m) / METERS_PER_MILE


def checkpoint_distances(total_m: float, interval_m: float) -> list[float]:
    """0, interval, 2*interval, ... plus the destination."""
    marks = [k * interval_m for k in range(int(total_m // interval_m) + 1)]
    if total_m - marks[-1] < MERGE_DISTANCE_M and len(marks) > 1:
        marks[-1] = total_m
    elif marks[-1] < total_m:
        marks.append(total_m)
    return marks


def sample_checkpoints(path: RoutePath, departure: datetime, interval_m: float) -> list[Checkpoint]:
    marks = checkpoint_distances(path.distance_m, interval_m)
    bounds = [0.0] + [(a + b) / 2 for a, b in zip(marks, marks[1:], strict=False)] + [marks[-1]]
    checkpoints = []
    for k, mark in enumerate(marks):
        i, t = locate(path.cum_distance_m, mark)
        (lat0, lon0), (lat1, lon1) = path.coords[i], path.coords[i + 1]
        seconds = lerp(path.cum_time_s[i], path.cum_time_s[i + 1], t)
        checkpoints.append(
            Checkpoint(
                index=k,
                distance_m=mark,
                lat=lerp(lat0, lat1, t),
                lon=lerp(lon0, lon1, t),
                eta=departure + timedelta(seconds=seconds),
                covers_from_m=bounds[k],
                covers_to_m=bounds[k + 1],
            )
        )
    return checkpoints
