"""Django settings. Everything deploy-specific comes from environment variables."""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIST = Path(os.environ.get("FRONTEND_DIST", BASE_DIR.parent / "frontend" / "dist"))


def env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


DEBUG = env_bool("DJANGO_DEBUG", default=True)
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-insecure-key")
if not DEBUG and SECRET_KEY == "dev-only-insecure-key":
    raise RuntimeError("DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is off")

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1")

# Railway injects RAILWAY_PUBLIC_DOMAIN; Render injects RENDER_EXTERNAL_HOSTNAME.
# Vercel injects VERCEL_URL (preview) and VERCEL_PROJECT_PRODUCTION_URL (production).
# Auto-add whichever is present so ALLOWED_HOSTS never needs manual config.
if railway_host := os.environ.get("RAILWAY_PUBLIC_DOMAIN"):
    ALLOWED_HOSTS.append(railway_host)
    CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS") + [f"https://{railway_host}"]
elif render_host := os.environ.get("RENDER_EXTERNAL_HOSTNAME"):
    ALLOWED_HOSTS.append(render_host)
    CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS")
else:
    CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS")

# Vercel: add deployment URLs to ALLOWED_HOSTS and CSRF_TRUSTED_ORIGINS.
# VERCEL_URL covers per-deployment preview URLs; VERCEL_PROJECT_PRODUCTION_URL
# covers the stable production URL (both are injected automatically by Vercel).
_vercel_origins: list[str] = []
if vercel_url := os.environ.get("VERCEL_URL"):
    ALLOWED_HOSTS.append(vercel_url)
    _vercel_origins.append(f"https://{vercel_url}")
if vercel_prod_url := os.environ.get("VERCEL_PROJECT_PRODUCTION_URL"):
    ALLOWED_HOSTS.append(vercel_prod_url)
    _vercel_origins.append(f"https://{vercel_prod_url}")
if _vercel_origins:
    CSRF_TRUSTED_ORIGINS = list(CSRF_TRUSTED_ORIGINS) + _vercel_origins

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "rest_framework",
    "planner",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.gzip.GZipMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

# The app is stateless: no models, so no database is needed.
DATABASES = {}

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "planner",
        "OPTIONS": {"MAX_ENTRIES": 20_000},
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True

# No Django static files: WhiteNoise only serves the built React app from the site root.
STATIC_URL = "static/"
STATIC_ROOT = None
WHITENOISE_ROOT = FRONTEND_DIST if FRONTEND_DIST.exists() else None
WHITENOISE_INDEX_FILE = True


def _immutable_vite_asset(path: str, url: str) -> bool:
    # Vite emits content-hashed files under /assets/, so they can be cached forever.
    return url.startswith("/assets/")


WHITENOISE_IMMUTABLE_FILE_TEST = _immutable_vite_asset

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": [],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "EXCEPTION_HANDLER": "planner.views.exception_handler",
    "DEFAULT_THROTTLE_RATES": {
        "plan": os.environ.get("PLAN_RATE_LIMIT", "20/min"),
        "geocode": os.environ.get("GEOCODE_RATE_LIMIT", "120/min"),
    },
}

if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_CONTENT_TYPE_NOSNIFF = True

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": os.environ.get("LOG_LEVEL", "INFO")},
    "loggers": {"httpx": {"level": "WARNING"}},
}

# --- Planner configuration -------------------------------------------------
PLANNER = {
    # TomTom truck routing + search when a key is present, else OSRM + Photon (keyless).
    "TOMTOM_API_KEY": os.environ.get("TOMTOM_API_KEY", ""),
    "OSRM_URL": os.environ.get("OSRM_URL", "https://router.project-osrm.org"),
    "PHOTON_URL": os.environ.get("PHOTON_URL", "https://photon.komoot.io"),
    # Optional paid Open-Meteo key (switches to the customer endpoint, lifts free-tier limits).
    "OPEN_METEO_API_KEY": os.environ.get("OPEN_METEO_API_KEY", ""),
    # Open-Meteo's free tier allows 600 location-calls per minute. The heatmap grid has a
    # fixed cell budget (so switching the sampling interval reuses cached grid forecasts),
    # and a plan never requests more than WEATHER_LOCATION_LIMIT distinct locations.
    "HEATMAP_CELLS": int(os.environ.get("HEATMAP_CELLS", "180")),
    "WEATHER_LOCATION_LIMIT": int(os.environ.get("WEATHER_LOCATION_LIMIT", "560")),
    "WEATHER_CACHE_SECONDS": int(os.environ.get("WEATHER_CACHE_SECONDS", "1800")),
    "HTTP_TIMEOUT_SECONDS": float(os.environ.get("HTTP_TIMEOUT_SECONDS", "20")),
    "GEOCODE_COUNTRIES": os.environ.get("GEOCODE_COUNTRIES", "US,CA"),
}
