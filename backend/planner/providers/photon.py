"""Keyless geocoding fallback using Photon (OpenStreetMap data, built for typeahead)."""

from __future__ import annotations

from django.conf import settings

from .base import Place
from .http import get_json

SEARCH_TIMEOUT_SECONDS = 6  # typeahead: better to fail fast than spin


def _label(props: dict) -> tuple[str, str]:
    street = " ".join(p for p in (props.get("housenumber"), props.get("street")) if p)
    name = props.get("name") or street or props.get("city") or ""
    locality = [props.get("city"), props.get("state"), props.get("countrycode")]
    detail = ", ".join(p for p in locality if p and p != name)
    return name, detail


class PhotonGeocoder:
    name = "photon"

    def __init__(self, countries: str, base_url: str | None = None):
        self.base_url = (base_url or settings.PLANNER["PHOTON_URL"]).rstrip("/")
        self.countries = {c.strip().upper() for c in countries.split(",") if c.strip()}

    def search(self, query: str, limit: int = 5) -> list[Place]:
        # Photon has no country filter, so over-fetch and filter locally.
        data = get_json(
            "the place search service",
            f"{self.base_url}/api/",
            params={"q": query, "limit": limit * 3, "lang": "en"},
            timeout=SEARCH_TIMEOUT_SECONDS,
        )
        places: list[Place] = []
        seen: set[tuple[str, str]] = set()
        for feature in data.get("features", []):
            props = feature.get("properties", {})
            if self.countries and props.get("countrycode", "").upper() not in self.countries:
                continue
            label, detail = _label(props)
            if not label or (label, detail) in seen:
                continue
            seen.add((label, detail))
            lon, lat = feature["geometry"]["coordinates"]
            places.append(Place(label=label, detail=detail, lat=lat, lon=lon))
            if len(places) == limit:
                break
        return places
