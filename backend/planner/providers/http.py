"""Shared HTTP client with consistent timeouts and error mapping."""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

import httpx
from django.conf import settings

from .base import ProviderError, RateLimitedError

logger = logging.getLogger(__name__)

USER_AGENT = "truck-weather-routing/1.0 (+https://github.com)"


@lru_cache(maxsize=1)
def client() -> httpx.Client:
    # httpx.Client is thread-safe and pools connections across the worker threads
    # the planner uses for parallel upstream calls.
    return httpx.Client(
        timeout=settings.PLANNER["HTTP_TIMEOUT_SECONDS"],
        headers={"User-Agent": USER_AGENT},
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        follow_redirects=True,
        # Retries failed connection attempts once (dropped Wi-Fi, a DNS blip, a stale
        # pooled connection); a request that reached the server is never re-sent.
        transport=httpx.HTTPTransport(retries=1),
    )


def _cap(service: str) -> str:
    """`service` reads mid-sentence ("the OSRM routing service"); capitalise to start one."""
    return service[:1].upper() + service[1:]


def get_json(
    service: str,
    url: str,
    params: Any = None,
    *,
    ok_statuses: frozenset = frozenset(),
    timeout: float | None = None,
):
    """GET and decode JSON. Statuses in `ok_statuses` (e.g. a provider's documented
    400 "no route" reply) are returned to the caller instead of raising. `timeout`
    overrides the default for latency-sensitive calls such as typeahead search."""
    try:
        response = client().get(
            url, params=params, timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT
        )
    except httpx.TimeoutException as exc:
        raise ProviderError(
            f"{_cap(service)} didn't respond in time. Try again.", status_code=504
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning("%s connection failed: %s", service, exc)
        raise ProviderError(
            f"Couldn't reach {service}. The server may have lost its internet connection; "
            "try again in a moment."
        ) from exc

    if response.status_code == 429:
        raise RateLimitedError(f"{_cap(service)} is at its request limit. Try again in a minute.")
    if response.status_code >= 400 and response.status_code not in ok_statuses:
        logger.warning("%s HTTP %s: %s", service, response.status_code, response.text[:500])
        raise ProviderError(
            f"{_cap(service)} returned an error (HTTP {response.status_code}). Try again shortly."
        )
    try:
        return response.json()
    except ValueError as exc:
        raise ProviderError(f"{_cap(service)} returned an unreadable response.") from exc
