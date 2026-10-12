"""Turn an hourly forecast into the weather a truck sees at a specific moment."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .geo import lerp
from .providers.openmeteo import HourlySeries
from .risk import Conditions


@dataclass(frozen=True)
class WeatherSample:
    wind_mph: float
    gust_mph: float
    rain_in_hr: float
    snow_in_hr: float
    temp_f: float | None
    weather_code: int | None

    @property
    def conditions(self) -> Conditions:
        return Conditions(
            wind_mph=self.wind_mph, rain_in_hr=self.rain_in_hr, snow_in_hr=self.snow_in_hr
        )


def _value(values: tuple, i: int | None) -> float | None:
    return values[i] if i is not None and 0 <= i < len(values) else None


def _interpolate(values: tuple, i0: int, fraction: float) -> float | None:
    a, b = _value(values, i0), _value(values, i0 + 1)
    if a is None or b is None:
        return a if b is None else b
    return lerp(a, b, fraction)


def sample_at(series: HourlySeries, when: datetime) -> WeatherSample:
    """Weather at `when`:

    - instantaneous values (wind, temperature) are interpolated linearly between
      the surrounding hours;
    - hourly totals (rain, snow, max gust) come from the hour interval that
      contains `when`. Open-Meteo labels those intervals by their end, so a truck
      passing at 14:20 gets the 14:00-15:00 total stored at 15:00.
    """
    epoch = int(when.timestamp())
    i0 = series.index_of(epoch - epoch % 3600)
    if i0 is None:
        raise ValueError(f"{when.isoformat()} is outside the fetched forecast window")
    fraction = (epoch % 3600) / 3600
    interval = i0 + 1 if fraction > 0 else i0

    def total(values: tuple) -> float:
        return _value(values, interval) or 0.0

    return WeatherSample(
        wind_mph=_interpolate(series.wind_mph, i0, fraction) or 0.0,
        gust_mph=total(series.gust_mph),
        rain_in_hr=total(series.rain_in),
        snow_in_hr=total(series.snow_in),
        temp_f=_interpolate(series.temp_f, i0, fraction),
        weather_code=_value(series.weather_code, i0 + round(fraction)),
    )
