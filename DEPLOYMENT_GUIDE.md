# Deployment Guide

This project has three runtime components:

1. API process: `node server.js`
2. Background worker: `node worker.js`
3. Redis 7-compatible service with persistence

The API and worker must share the same queue and Redis database. Run them as separate services/processes; do not omit the worker because delivery jobs will remain queued.

## Docker

Copy `.env.example` for local development only. In production, set secrets and configuration through the hosting platform or container runtime.

```bash
docker compose up -d --build
```

Compose provides:

- Redis 7 with append-only persistence in `redis_data`
- API on the host port configured by `PORT`
- Worker with its BullMQ lock and outbound destination limiter
- Redis, API, and worker health checks

Set at minimum:

- `API_KEY`
- `ALLOWED_ORIGINS`
- `REDIS_PASSWORD` when Redis authentication is enabled

Optional public-Redis deployments can use `REDIS_URL=rediss://...` on both API and worker. Individual `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASSWORD` settings are used for local Compose.

Do not put real secrets in `.env.example`, Compose files, README examples, Git, or container images.

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

## Hosted public deployment

Use a separate web service for the API and a separate background/worker service for `npm run worker` or `node worker.js`. A worker cannot use an HTTP-only web process that suspends or sleeps, and the API process alone cannot deliver queued webhooks.

Use a managed Redis service or persistent Redis VM. SQLite or ephemeral free disk is not a BullMQ/Redis replacement. Worker and API instances must use the same Redis URL/database and Redis password/TLS settings.

Common free-tier limitations:

- Web services may sleep; keep the API reachable through normal platform health checks.
- Background-worker services may not be available on HTTP-only or static hosting free tiers.
- Redis free tiers commonly have memory, connection, eviction, TLS, database, or persistence limits.
- Ephemeral containers lose queued jobs and destination state unless Redis and Redis persistence are external.
- Port and process limits can prevent one container from exposing both API and worker processes; deploy them as separate services.

The API health route is `GET /health/live`. The readiness route is `GET /health/ready` and verifies Redis/worker state. The worker metrics route is `GET /metrics` on worker port `9090`.

## Checks

- API liveness: `GET /health/live`
- API readiness: `GET /health/ready`
- API metrics: `GET /metrics`
- Worker metrics: `GET http://<worker-host>:9090/metrics`

Post-deployment checklist:

1. Confirm the Redis URL is shared by API and worker and a Redis `PING` succeeds.
2. Confirm `/health/live` returns 200 and `/health/ready` reports ready.
3. Confirm the worker service stays running and `/metrics` or worker logs show active BullMQ processing.
4. Send a protected status or dispatch request with the configured API key.
5. Dispatch a test webhook to a public HTTPS endpoint you control.
6. Confirm the job completes and Redis-backed destination limits are enforced.
