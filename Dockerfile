# Single service: Django serves the API and the built React app (via WhiteNoise).

FROM node:24-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    DJANGO_DEBUG=false \
    FRONTEND_DIST=/app/frontend/dist
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/ ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist
# Pre-compress the bundle (gzip + brotli) so WhiteNoise can serve it compressed.
RUN .venv/bin/python -m whitenoise.compress /app/frontend/dist
RUN useradd --create-home app
USER app
ENV PATH="/app/backend/.venv/bin:$PATH" PORT=8000
EXPOSE 8000
# Threads let one worker overlap the many upstream HTTP calls a plan makes.
CMD ["sh", "-c", "exec gunicorn config.wsgi:application --bind 0.0.0.0:${PORT} --workers 2 --threads 4 --timeout 90 --access-logfile -"]
