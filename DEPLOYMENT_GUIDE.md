# Deployment Guide

## Docker

Set deployment variables before running Compose:

```bash
API_KEY=<secure-random-key> ALLOWED_ORIGINS=<allowed-origin> docker compose up -d --build
```

Optional Redis authentication:

```bash
REDIS_PASSWORD=<secure-password>
```

Compose provides the API, worker, and Redis services with persistent `redis_data`, restart policies, and health checks. Docker does not manage or alter the existing local Memurai service.

## Standalone Node.js

API:

```bash
npm start
```

Worker:

```bash
npm run worker
```

Set `NODE_ENV=production`, `API_KEY`, Redis settings, allowed origins, and rate limits through the process environment. Do not read or print secret values from `.env`.

## Checks

- API liveness: `GET /health/live`
- API readiness: `GET /health/ready`
- API metrics: `GET /metrics`
- Worker metrics: `GET http://<worker-host>:9090/metrics`
