# Webhook Dispatcher Engine

A distributed, secure webhook delivery system built with Node.js, Express, and BullMQ. Features robust SSRF protection, DNS rebinding prevention, and reliable job processing with exponential backoff retry.

---

## 📋 Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Security](#security)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Development](#development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)

---

## ✨ Features

### Core Functionality
- **Asynchronous Webhook Delivery** - Queue-based architecture for reliable delivery
- **Automatic Retries** - 5 attempts with exponential backoff (2s, 4s, 8s, 16s)
- **High Throughput** - Concurrent worker processing (configurable concurrency)
- **Job Persistence** - Redis-backed queue with configurable retention

### Security
- **SSRF Protection** - Multi-layer validation against Server-Side Request Forgery
- **DNS Rebinding Prevention** - Re-validation at delivery time with connection pinning
- **Private IP Filtering** - Blocks RFC1918, loopback, link-local, and cloud metadata endpoints
- **Connection Pinning** - Forces validated IP addresses, prevents DNS manipulation
- **Request Limits** - Configurable timeout (30s) and response size limit (1MB)
- **No Redirects** - Automatic redirect following disabled

### Reliability
- **Graceful Shutdown** - Waits for active jobs before terminating
- **Dead Letter Queue** - Failed jobs retained for 7 days
- **Job Retention** - Completed jobs kept for 24 hours
- **Connection Pooling** - Efficient Redis connection management

---

## 🏗️ Architecture

### Components

```
┌─────────────────────────────────────────┐
│         API Server (server.js)          │
│  - Express REST API                     │
│  - Input Validation                     │
│  - SSRF Protection Layer 1              │
│  - BullMQ Queue Producer                │
└─────────────┬───────────────────────────┘
              │
              │ Jobs via Redis
              ▼
┌─────────────────────────────────────────┐
│            Redis / Memurai              │
│  - Job Queue: "webhooks"                │
│  - State Management                     │
│  - Persistence Layer                    │
└─────────────┬───────────────────────────┘
              │
              │ Consume Jobs
              ▼
┌─────────────────────────────────────────┐
│      Worker Process (worker.js)         │
│  - BullMQ Job Consumer                  │
│  - SSRF Protection Layer 2              │
│  - DNS Rebinding Prevention             │
│  - Connection Pinning                   │
│  - HTTP POST Delivery                   │
└─────────────────────────────────────────┘
```

### Data Flow

1. **Client** submits webhook via POST `/api/webhooks/dispatch`
2. **API Server** validates input and destination URL
3. **Job** is queued in Redis with unique UUID
4. **API** returns HTTP 202 with job ID immediately
5. **Worker** picks up job from queue
6. **Worker** re-validates destination (TOCTOU protection)
7. **Worker** delivers webhook via HTTP POST
8. **Worker** handles response and retries if needed

---

## 🔒 Security

### SSRF Protection Layers

#### Layer 1: Ingestion-Time Validation
- Validates URL format and protocol (http/https only)
- Blocks private IP addresses (10.x, 192.168.x, 172.16-31.x)
- Blocks loopback addresses (127.x, ::1)
- Blocks link-local addresses (169.254.x - cloud metadata)
- Performs DNS lookup and validates all resolved IPs
- Rejects if ANY resolved IP is non-public

#### Layer 2: Delivery-Time Re-validation
- Worker re-validates URL before HTTP request
- Protects against DNS rebinding attacks
- Validates ALL A and AAAA records
- Filters out any private/loopback IPs discovered

#### Layer 3: Connection Pinning
- Uses custom DNS lookup callback
- Forces connection to validated IP address
- Prevents automatic DNS resolution by HTTP client
- Preserves hostname for TLS SNI and Host header

### Protected Against

- ✅ SSRF to private networks (RFC1918)
- ✅ SSRF to localhost/loopback
- ✅ SSRF to cloud metadata endpoints (AWS, GCP, Azure)
- ✅ DNS rebinding attacks (TOCTOU)
- ✅ IPv4-mapped IPv6 bypass attempts
- ✅ URL redirects to private IPs
- ✅ Slow Loris attacks (timeout protection)
- ✅ Response body memory exhaustion

---

## 📦 Prerequisites

- **Node.js** v18+ (ES modules support)
- **Redis** 6+ or **Memurai** (Windows)
- **npm** or **yarn**

---

## 🚀 Installation

### 1. Clone Repository
```bash
git clone https://github.com/ShyamaliSamant/secure-webhook-dispatcher.git
cd secure-webhook-dispatcher
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Install Redis

**Linux/macOS:**
```bash
# Ubuntu/Debian
sudo apt-get install redis-server

# macOS
brew install redis
```

**Windows:**
- Install [Memurai](https://www.memurai.com/) (Redis-compatible)
- Or use [WSL with Ubuntu](https://docs.microsoft.com/en-us/windows/wsl/install)

### 4. Configure Environment
```bash
cp .env.example .env
# Edit only the local .env for development
```

Required variables:

| Variable | Local default | Production requirement |
|----------|---------------|------------------------|
| `NODE_ENV` | `development` | Set to `production` |
| `API_KEY` | Not set | Required; set through the process environment or secret manager |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Use the reachable Redis host and port |
| `REDIS_URL` | Not set | Alternative to host/port; use `rediss://` for TLS Redis |
| `REDIS_PASSWORD` | Not set | Set only if Redis authentication is enabled |
| `ALLOWED_ORIGINS` | Not set | Required for browser CORS in production |

Optional worker and API settings include `PORT`, `WORKER_CONCURRENCY`, `WEBHOOK_TIMEOUT`, `MAX_RESPONSE_SIZE`, `RATE_LIMIT_*`, `WORKER_JOB_LOCK_DURATION_MS`, and `DESTINATION_RATE_LIMIT_*`.

Never commit `.env` or put real secrets in `.env.example`, logs, source code, or shell history.

## API / worker / Redis architecture

- The Express API (`server.js`) validates requests and adds BullMQ jobs to Redis.
- The background worker (`worker.js`) consumes jobs and performs SSRF validation, DNS pinning, outbound destination rate limiting, HTTP delivery, retries, and DLQ handling.
- Redis stores the BullMQ queue, worker heartbeat, dead-letter state, and shared per-domain destination limiter counters.
- API and worker are separate processes. Deploy or start both against the same Redis database.

---

## ⚙️ Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# Server Configuration
PORT=5000
NODE_ENV=development
API_KEY=
API_KEY_HEADER=X-API-Key
ALLOWED_ORIGINS=

# Redis Configuration
# Option 1: Use connection string
REDIS_URL=redis://localhost:6379

# Option 2: Use individual settings (default if REDIS_URL not set)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Worker Configuration
WORKER_CONCURRENCY=5         # Number of concurrent jobs
WEBHOOK_TIMEOUT=30000        # Request timeout in milliseconds (30s)
MAX_RESPONSE_SIZE=1048576    # Max response size in bytes (1MB)
```

### Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 5000 | API server port |
| `REDIS_HOST` | localhost | Redis server hostname |
| `REDIS_PORT` | 6379 | Redis server port |
| `REDIS_PASSWORD` | - | Redis authentication password |
| `REDIS_URL` | - | Full Redis connection string (overrides host/port) |
| `WORKER_CONCURRENCY` | 5 | Number of concurrent webhook deliveries |
| `WEBHOOK_TIMEOUT` | 30000 | HTTP request timeout (ms) |
| `MAX_RESPONSE_SIZE` | 1048576 | Maximum response body size (bytes) |
| `WORKER_JOB_LOCK_DURATION_MS` | 300000 | BullMQ job lock duration while delivery/rate-limit waits are active |
| `DESTINATION_RATE_LIMIT_MAX` | 10 | Maximum outbound requests per destination in the configured duration |
| `DESTINATION_RATE_LIMIT_DURATION` | 60000 | Destination sliding-window duration in milliseconds |
| `DESTINATION_RATE_LIMIT_KEY_PREFIX` | `webhook-dispatcher:destination-rate-limit` | Redis key namespace for shared destination limits |

### Outbound destination rate limiting

Before each webhook HTTP request, the worker applies a per-hostname sliding-window limit. The window state is stored in Redis, so every worker process shares the same counters. Hostnames are normalized to lowercase (including removing a trailing dot), and limits are independent for each destination domain.

When the limit is reached, the worker waits for the oldest request to leave the sliding window rather than rejecting or dropping the job. The BullMQ job lock is renewed during this wait, allowing the worker to remain active for a configurable window. Redis failures fail the delivery normally for BullMQ retry rather than bypassing the configured limit.

An upstream HTTP `429` is retryable. Existing permanent `4xx`, SSRF, redirect, `5xx`, network, timeout, and response-size behavior is unchanged.

---

## 🎯 Usage

### Start Redis
```bash
# Linux/macOS
redis-server

# Windows (Memurai)
# Service starts automatically, or:
net start Memurai
```

### Start API Server
```bash
npm start
```

The API server will start on `http://localhost:5000`

### Start Worker
```bash
# In a separate terminal
npm run worker
```

### Development Mode (with auto-restart)

## Security and Deployment

- Production startup requires `API_KEY`; authentication uses `crypto.timingSafeEqual`.
- Protected API routes require `X-API-Key` unless development mode is intentionally used.
- Configure `ALLOWED_ORIGINS` as a comma-separated origin allowlist.
- Health endpoints are public for orchestration probes.
- Docker deployment is defined in `docker-compose.yml`; Redis data is retained in `redis_data`.
- Local Memurai is separate and is not managed or modified by Docker Compose. Mode (with auto-restart)
```bash
# Terminal 1: API Server
npm run dev

# Terminal 2: Worker
npm run worker:dev
```

---

## 📡 API Reference

### Submit Webhook

**Endpoint:** `POST /api/webhooks/dispatch`

**Request Headers:**
```
Content-Type: application/json
```

**Request Body:**
```json
{
  "destinationUrl": "https://example.com/webhook",
  "eventId": "order.created.123",
  "payload": {
    "orderId": "ORD-12345",
    "amount": 99.99,
    "timestamp": "2024-01-01T12:00:00Z"
  }
}
```

**Success Response (HTTP 202):**
```json
{
  "status": "queued",
  "jobId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Error Response (HTTP 400):**
```json
{
  "success": false,
  "error": "Validation failed",
  "details": "Private IP addresses are not allowed"
}
```

**Error Response (HTTP 503):**
```json
{
  "success": false,
  "error": "Queue service temporarily unavailable",
  "details": "Unable to queue webhook for delivery. Please try again later."
}
```

### Health Check

**Endpoint:** `GET /health`

**Response (HTTP 200):**
```json
{
  "success": true,
  "message": "Webhook Dispatcher API is running"
}
```

---

## 🧪 Testing

### Manual Testing

#### 1. Test Successful Delivery
```bash
export API_KEY="your-local-api-key"
curl -X POST http://localhost:5000/api/webhooks/dispatch \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "destinationUrl": "https://webhook.site/unique-id",
    "eventId": "test-123",
    "payload": {"test": "data"}
  }'
```

Expected: HTTP 202 with jobId

#### 2. Test SSRF Protection
```bash
# Should be blocked with HTTP 400
curl -X POST http://localhost:5000/api/webhooks/dispatch \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "destinationUrl": "http://localhost/webhook",
    "eventId": "test-ssrf",
    "payload": {}
  }'
```

Expected: HTTP 400 - "Private IP addresses are not allowed"

#### 3. Test Cloud Metadata Protection
```bash
# Should be blocked with HTTP 400
curl -X POST http://localhost:5000/api/webhooks/dispatch \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "destinationUrl": "http://169.254.169.254/latest/meta-data",
    "eventId": "test-metadata",
    "payload": {}
  }'
```

Expected: HTTP 400 - "Cloud metadata endpoints are not allowed"

### Test Services

Use these public webhook testing services:
- [webhook.site](https://webhook.site/) - Inspect incoming webhooks
- [httpbin.org](https://httpbin.org/post) - Echo service
- [requestbin.com](https://requestbin.com/) - Request inspection

---

## 🚢 Deployment

### Docker Compose

The current setup starts API, worker, and Redis as separate services:

```bash
docker compose up -d --build
```

Set `API_KEY`, `ALLOWED_ORIGINS`, and optional `REDIS_PASSWORD` through the deployment environment or a local untracked `.env`; never commit secrets. The compose Redis volume `redis_data` persists Redis append-only data.

### Public hosting

Deploy `server.js` as an API/web service and `worker.js` as a separate always-on background service. Both services must receive the same `REDIS_URL` or Redis host/port/password settings and database. Use `rediss://` URLs for TLS Redis providers.

Free-tier limitations:

- HTTP/static free tiers cannot reliably run BullMQ background workers.
- Sleeping web services can delay API/health traffic.
- Managed Redis free tiers may limit memory, connections, persistence, eviction behavior, or TLS support.
- Ephemeral container storage is not durable Redis storage.

Required production environment:

- `NODE_ENV=production`
- `API_KEY`
- `ALLOWED_ORIGINS`
- `REDIS_URL` or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`
- Worker settings: `WORKER_CONCURRENCY`, `WEBHOOK_TIMEOUT`, `MAX_RESPONSE_SIZE`
- Destination limit settings: `DESTINATION_RATE_LIMIT_MAX`, `DESTINATION_RATE_LIMIT_DURATION`, optional key prefix

Health checks:

- API liveness: `GET /health/live`
- API readiness: `GET /health/ready`
- Worker metrics: `GET http://<worker-host>:9090/metrics`

Deployment verification:

1. Confirm Redis `PING` from both API and worker.
2. Confirm `/health/live` returns 200.
3. Confirm `/health/ready` reports Redis and worker healthy.
4. Confirm the worker remains running and remains reachable on port 9090 internally.
5. Send an authenticated status request.
6. Dispatch a test webhook to an endpoint you control and confirm the job completes.

---

## 🔧 Troubleshooting

### Issue: Worker doesn't process jobs

**Symptoms:** Jobs stay in "waiting" state

**Solutions:**
1. Check worker is running: `ps aux | grep worker`
2. Verify Redis connection: `redis-cli PING` should return `PONG`
3. Check worker logs for errors
4. Verify queue name matches: "webhooks"
5. Ensure `maxRetriesPerRequest: null` in worker Redis config

### Issue: API returns 503

**Symptoms:** All webhook submissions return HTTP 503

**Solutions:**
1. Check Redis is running: `redis-cli PING`
2. Verify Redis connection in .env
3. Check Redis password if configured
4. Restart API server: `npm start`
5. Check for stale server processes

### Issue: SSRF protection too strict

**Symptoms:** Valid public URLs are blocked

**Solutions:**
1. Check DNS resolution: `nslookup domain.com`
2. Verify all resolved IPs are public
3. Check for IPv6 addresses resolving to private ranges
4. Test with alternative domain if DNS issue

### Issue: Webhooks fail with timeout

**Symptoms:** Worker logs show timeout errors

**Solutions:**
1. Increase timeout: `WEBHOOK_TIMEOUT=60000` in .env
2. Check destination server response time
3. Verify network connectivity
4. Check for rate limiting on destination

### Issue: High memory usage

**Symptoms:** Worker process memory grows

**Solutions:**
1. Reduce concurrency: `WORKER_CONCURRENCY=2`
2. Reduce response size limit: `MAX_RESPONSE_SIZE=524288`
3. Check for memory leaks in logs
4. Restart worker periodically with process manager

---

## 📁 Project Structure

```
webhook-dispatcher/
├── src/
│   ├── config/
│   │   └── redis.js              # Redis configuration
│   ├── controllers/
│   │   └── webhookController.js  # Webhook dispatch handler
│   ├── middleware/
│   │   └── validateWebhook.js    # Input validation
│   ├── queues/
│   │   └── webhookQueue.js       # BullMQ queue setup
│   ├── routes/
│   │   └── webhookRoutes.js      # API routes
│   ├── utils/
│   │   ├── generateJobId.js      # UUID generation
│   │   └── ssrfProtection.js     # SSRF validation
│   ├── workers/
│   │   ├── webhookWorker.js      # BullMQ worker
│   │   └── deliveryService.js    # HTTP delivery
│   └── app.js                    # Express app
├── server.js                      # API server entry point
├── worker.js                      # Worker entry point
├── package.json
├── .env.example
└── README.md
```

### Key Files

- **`server.js`** - API server entry point, starts Express app
- **`worker.js`** - Worker process entry point, consumes jobs from queue
- **`src/app.js`** - Express app configuration, middleware, routes
- **`src/queues/webhookQueue.js`** - BullMQ queue producer (API side)
- **`src/workers/webhookWorker.js`** - BullMQ worker consumer
- **`src/workers/deliveryService.js`** - HTTP delivery with SSRF protection
- **`src/utils/ssrfProtection.js`** - SSRF validation utilities
- **`src/config/redis.js`** - Redis connection configs (separate for API and Worker)

---

## 📊 Monitoring

### Key Metrics

Monitor these metrics in production:

- **Queue Depth** - Number of waiting jobs
- **Failed Jobs** - Number of permanently failed jobs
- **Job Latency** - Time from queue to completion
- **Delivery Success Rate** - Percentage of successful deliveries
- **Worker Health** - Process uptime and memory usage
- **Redis Connection** - Connection status and latency

### Logging

All logs include job ID for correlation:

```
[550e8400-e29b-41d4-a716-446655440000] Processing webhook job (attempt 1/5)
[550e8400-e29b-41d4-a716-446655440000] EventId: order.created.123
[550e8400-e29b-41d4-a716-446655440000] Destination: example.com
[550e8400-e29b-41d4-a716-446655440000] Validating destination URL...
[550e8400-e29b-41d4-a716-446655440000] URL validation passed
[550e8400-e29b-41d4-a716-446655440000] Resolving DNS for example.com...
[550e8400-e29b-41d4-a716-446655440000] Resolved 2 address(es)
[550e8400-e29b-41d4-a716-446655440000] Pinning connection to 93.184.216.34 (IPv4)
[550e8400-e29b-41d4-a716-446655440000] Sending POST to example.com/webhook
[550e8400-e29b-41d4-a716-446655440000] Received HTTP 200
[550e8400-e29b-41d4-a716-446655440000] ✅ Delivery successful
```

---

## 🔐 Security Best Practices

1. **Never log sensitive data** - Payloads, auth headers, full URLs with secrets
2. **Keep Redis password secure** - Use strong passwords, rotate regularly
3. **Use HTTPS in production** - TLS for API and Redis connections
4. **Monitor failed jobs** - Alert on unusual failure patterns
5. **Rate limiting** - Add rate limits to API endpoints
6. **Input sanitization** - Validate all user input
7. **Update dependencies** - Regularly update npm packages
8. **Network isolation** - Run workers in isolated network segment

---

## 📝 License

ISC

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📮 Support

For issues and questions:
- Open an issue on GitHub
- Check existing documentation
- Review troubleshooting section

---

## 🎯 Roadmap

- [ ] Add webhook signature/authentication (HMAC-SHA256)
- [ ] Add job status API endpoint (GET /jobs/:jobId)
- [ ] Add retry API endpoint (POST /jobs/:jobId/retry)
- [ ] Add Prometheus metrics export
- [ ] Add event-level idempotency (deduplication by eventId)
- [ ] Add admin dashboard for queue monitoring
- [ ] Add webhook templates and transformations
- [ ] Add batching support for high-volume scenarios

---

**Built with ❤️ using Node.js, Express, and BullMQ**
