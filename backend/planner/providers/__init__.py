"""Provider selection: TomTom when a key is configured, keyless OSRM/Photon otherwise.

If TomTom fails for a reason other than "no route" (quota, outage, bad key), the
request falls back to the keyless provider instead of failing the plan.
"""

from __future__ import annotations

import logging

from django.conf import settings

from ..geo import LatLon
from .base import (
    Geocoder,
    NoRouteError,
    Place,
    ProviderError,
    RoutePath,
    RoutingProvider,
    TruckProfile,
)
from .osrm import OsrmRouter
from .photon import PhotonGeocoder
from .tomtom import TomTomGeocoder, TomTomRouter

logger = logging.getLogger(__name__)


class FallbackRouter:
    def __init__(self, primary: RoutingProvider, fallback: RoutingProvider):
        self.primary, self.fallback = primary, fallback
        self.name = primary.name

    def _call(self, method: str, *args):
        try:
            result = getattr(self.primary, method)(*args)
            self.name = self.primary.name
            return result
        except NoRouteError:
            raise
        except ProviderError as exc:
            logger.warning(
                "%s failed (%s); falling back to %s", self.primary.name, exc, self.fallback.name
            )
            self.name = self.fallback.name
            return getattr(self.fallback, method)(*args)

    def routes(
        self, origin: Place, destination: Place, truck: TruckProfile, alternatives: int
    ) -> list[RoutePath]:
        return self._call("routes", origin, destination, truck, alternatives)

    def route_through(self, points: list[LatLon], truck: TruckProfile) -> RoutePath:
        # Stay on whichever provider produced the main routes, for consistent ETAs.
        provider = self.primary if self.name == self.primary.name else self.fallback
        return provider.route_through(points, truck)


class FallbackGeocoder:
    def __init__(self, primary: Geocoder, fallback: Geocoder):
        self.primary, self.fallback = primary, fallback
        self.name = primary.name

    def search(self, query: str, limit: int = 5) -> list[Place]:
        try:
            return self.primary.search(query, limit)
        except ProviderError as exc:
            logger.warning("%s geocoding failed (%s); falling back", self.primary.name, exc)
            return self.fallback.search(query, limit)


def get_router() -> RoutingProvider:
    config = settings.PLANNER
    if config["TOMTOM_API_KEY"]:
        return FallbackRouter(TomTomRouter(config["TOMTOM_API_KEY"]), OsrmRouter())
    return OsrmRouter()


def get_geocoder() -> Geocoder:
    config = settings.PLANNER
    photon = PhotonGeocoder(config["GEOCODE_COUNTRIES"])
    if config["TOMTOM_API_KEY"]:
        return FallbackGeocoder(
            TomTomGeocoder(config["TOMTOM_API_KEY"], config["GEOCODE_COUNTRIES"]), photon
        )
    return photon
