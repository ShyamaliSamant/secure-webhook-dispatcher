# Security

## Authentication

Set `API_KEY` and `API_KEY_HEADER` for production deployments. Production startup exits if `API_KEY` is missing. Protected routes use timing-safe key comparison. Health and metrics routes follow the network policy documented by the deployment configuration.

## Network Controls

- Configure `ALLOWED_ORIGINS` explicitly for browser clients.
- Set `TRUST_PROXY=true` only behind a trusted reverse proxy.
- Rate limits are per client IP and configurable with `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`, and `RATE_LIMIT_DISPATCH_MAX`.
- Metrics endpoints should be restricted by firewall or internal network policy.

## Delivery Security

Webhook destinations enforce SSRF protection, private IPv4/IPv6 filtering, DNS re-validation, connection pinning, timeout and response-size limits, and redirect blocking.

## Secrets

Never commit `.env`, API keys, Redis passwords, or credentials. Supply secrets through the deployment environment or secret manager.
