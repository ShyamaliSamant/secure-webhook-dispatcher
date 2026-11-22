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

## Railway deployment

Railway deploys each service separately. Add the GitHub repository as the source for the API and Worker services, and add a Redis database in the same project/environment.

### 1. Redis service

1. In the Railway project, choose `New` → `Database` → `Redis`.
2. Keep the Redis database private; do not create public TCP access unless an external system must connect outside the Railway project.
3. The Railway Redis service provides connection variables including `REDIS_URL`.
4. Redis data persistence is managed through the attached Railway database volume according to the template configuration.

### 2. API service

1. Create a service from the GitHub repository.
2. Set the start command to `node server.js`.
3. Ensure the service uses the project Dockerfile. Railway injects `PORT`; the API listens on that value.
4. Under `Settings → Networking → Public Networking`, generate a `.railway.app` domain.
5. Under `Settings`, set the health check path to `/health/live`. Railway expects a `2xx` response and has a 300-second default timeout.
6. The API service should use private Railway networking and `REDIS_URL` for Redis.

### 3. Worker service

1. Create a second service from the same GitHub repository.
2. Set the start command to `node worker.js`.
3. Do not generate a public domain for the worker. It is a background BullMQ consumer.
4. Set the worker variables in the Worker service, not in the API service.
5. The worker listens internally on `WORKER_METRICS_PORT` only if metrics need to be inspected through Railway logs or private networking.

### Railway reference variable syntax

Both API and Worker should receive the Redis service URL through a Railway reference variable. If the Redis service is named `Redis`, set this variable on both application services:

```text
REDIS_URL=${{Redis.REDIS_URL}}
```

The namespace is the other service's exact name, and the right side is the variable name. Railway resolves the reference value securely at deployment/runtime. Do not copy or commit the resolved Redis URL.

For a Redis service with a different name, replace `Redis` with that exact name:

```text
REDIS_URL=${{EXACT_REDIS_SERVICE_NAME.REDIS_URL}}
```

Do not use Railway public Redis variables for private service-to-service traffic. Keep Redis private inside the project.

### Production variables

Set these in the Railway Dashboard under each service's `Variables` tab. No real secret is included in this repository or this guide.

Common API variables:

- `NODE_ENV=production`
- `API_KEY` — set manually in the Railway Dashboard
- `ALLOWED_ORIGINS`
- `REDIS_URL` — set by the Railway reference variable
- `TRUST_PROXY`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX_REQUESTS`
- `RATE_LIMIT_DISPATCH_MAX`
- `LOG_LEVEL`

Common Worker variables:

- `NODE_ENV=production`
- `REDIS_URL` — set by the Railway reference variable
- `WORKER_CONCURRENCY`
- `WORKER_JOB_LOCK_DURATION_MS`
- `WEBHOOK_TIMEOUT`
- `MAX_RESPONSE_SIZE`
- `WORKER_METRICS_PORT`
- `DESTINATION_RATE_LIMIT_MAX`
- `DESTINATION_RATE_LIMIT_DURATION`
- `DESTINATION_RATE_LIMIT_KEY_PREFIX`

`API_KEY` must be manually entered as a Railway secret variable. `ALLOWED_ORIGINS` contains non-secret origin values. Do not set Redis passwords or Redis URLs in this repository.

### Railway dashboard setup checklist

1. Open the GitHub repository in Railway and create or confirm the `main` branch deployment source.
2. Create one Redis database service.
3. Create an API service from the repository and set start command `node server.js`.
4. Create a Worker service from the repository and set start command `node worker.js`.
5. Add `REDIS_URL=${{Redis.REDIS_URL}}` to API and Worker when the Redis service is named `Redis`.
6. Add `NODE_ENV=production` and the required API variables manually.
7. Enter `API_KEY` manually through the Railway Dashboard secret-variable UI.
8. Add the Worker variables manually; do not enable a public domain for the Worker.
9. Generate the API public domain under `Settings → Networking → Public Networking`.
10. Set API health check path `/health/live` and the timeout appropriate for the deployment.
11. Deploy or redeploy API, Worker, and Redis services after variables are saved.

### Verify deployment

1. Open API and Worker deployment logs and confirm both deployments become active.
2. Call the public API liveness endpoint:

   ```bash
   curl -i https://YOUR-API-DOMAIN.up.railway.app/health/live
   ```

3. Call readiness:

   ```bash
   curl -i https://YOUR-API-DOMAIN.up.railway.app/health/ready
   ```

   It should report Redis ready and a healthy worker heartbeat.

4. Verify missing authentication is rejected:

   ```bash
   curl -i https://YOUR-API-DOMAIN.up.railway.app/api/webhooks/status/test-job-id
   ```

5. Verify an authenticated status or dispatch request using the Dashboard-configured API key:

   ```bash
   curl -i https://YOUR-API-DOMAIN.up.railway.app/api/webhooks/status/test-job-id \
     -H "X-API-Key: $API_KEY"
   ```

   Set `$API_KEY` only in your local shell; do not include its value in a command script or repository file.

6. Dispatch to a public HTTPS endpoint you control:

   ```bash
   curl -i https://YOUR-API-DOMAIN.up.railway.app/api/webhooks/dispatch \
     -H "Content-Type: application/json" \
     -H "X-API-Key: $API_KEY" \
     -d '{"destinationUrl":"https://example.com/your-test-endpoint","eventId":"railway-verification","payload":{"source":"railway"}}'
   ```

7. Confirm the Worker logs show job processing and Redis connection, and confirm the destination test endpoint received the POST.
8. Query the API status endpoint with the returned `jobId` until it reaches a completed or final failed state.
9. Confirm Redis private connectivity in both API and Worker through `/health/ready` and Worker logs. Redis public TCP access is not required.

### Free plan limitations

Railway's Free plan is $0/month and includes $1 of resource usage per month. It runs services in serverless mode, so services sleep after approximately 5-10 minutes of outbound inactivity and wake on the next request. Redis and the worker's database connection can keep traffic active and therefore consume the usage allocation.

The $1 covers CPU, RAM, and egress usage together and resets at the billing cycle. It does not roll over. When the monthly usage limit is exhausted, Railway stops the services until the next billing cycle or until usage/plan state is restored. No paid-plan upgrade is required to use this documentation.

Official Railway references:

- [Variables](https://docs.railway.com/variables/reference)
- [Private Networking](https://docs.railway.com/networking/private-networking)
- [Redis](https://docs.railway.com/databases/redis)
- [Healthchecks](https://docs.railway.com/deployments/healthchecks)
- [Start Command](https://docs.railway.com/deployments/start-command)
- [Public Networking](https://docs.railway.com/networking/public-networking)
- [Free Plan](https://docs.railway.com/pricing/free-plan)
