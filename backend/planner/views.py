from __future__ import annotations

from django.conf import settings
from django.core.cache import cache
from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework.views import exception_handler as drf_exception_handler

from .providers import get_geocoder
from .providers.base import ProviderError
from .serializers import SAMPLE_INTERVALS_MI, PlanRequestSerializer, place_dict, plan_dict
from .service import plan_trip

GEOCODE_CACHE_SECONDS = 24 * 3600


def exception_handler(exc, context):
    """Upstream provider failures become a JSON error with a helpful status code."""
    if isinstance(exc, ProviderError):
        return Response({"detail": str(exc)}, status=exc.status_code)
    return drf_exception_handler(exc, context)


class HealthView(APIView):
    def get(self, request: Request) -> Response:
        return Response(
            {
                "status": "ok",
                "routing": "tomtom" if settings.PLANNER["TOMTOM_API_KEY"] else "osrm",
                "weather": "open-meteo",
                "sample_intervals_mi": SAMPLE_INTERVALS_MI,
            }
        )


class GeocodeView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "geocode"

    def get(self, request: Request) -> Response:
        query = request.query_params.get("q", "").strip()
        if len(query) < 2:
            return Response({"results": []})
        key = f"geocode:{query.lower()}"
        results = cache.get(key)
        if results is None:
            results = [place_dict(p) for p in get_geocoder().search(query[:200], limit=6)]
            cache.set(key, results, GEOCODE_CACHE_SECONDS)
        return Response({"results": results})


class PlanView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "plan"

    def post(self, request: Request) -> Response:
        serializer = PlanRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        trip = serializer.to_trip_request(get_geocoder())
        return Response(plan_dict(plan_trip(trip)), status=status.HTTP_200_OK)
