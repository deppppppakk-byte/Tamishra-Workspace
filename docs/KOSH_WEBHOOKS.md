# Kosh Webhooks & Integrations

Kosh Webhooks is the native outbound event integration layer for repository activity. It is vendor-neutral: an integration is an HTTPS endpoint subscribed to one or more Kosh events.

## Security model

- Repository reads require `repository.read`.
- Endpoint creation, updates, testing, redelivery, secret rotation and deletion require `repository.write`.
- Browser mutations enforce the Workspace allowed-origin boundary.
- Every endpoint receives an independent random 256-bit signing secret.
- Signing secrets are stored through the encrypted Kosh secret store and are only returned to the user when created or rotated.
- Production endpoints require HTTPS.
- URL credentials are rejected.
- Localhost, `.local`, `.internal`, loopback, link-local, RFC1918/private, carrier-grade NAT, documentation, multicast and other non-public IP ranges are rejected while private-network blocking is enabled.
- Redirects are not followed.
- Every webhook delivery is bounded by a configurable timeout and maximum attempt count.

`KOSH_WEBHOOK_BLOCK_PRIVATE_NETWORKS=false` should only be used for deliberately isolated development installations. It should remain enabled on shared and production gateways.

## Events

Current repository event subscriptions:

- `push`
- `change_review.opened`
- `change_review.merged`
- `issue.created`
- `issue.updated`
- `workflow.completed`
- `package.published`
- `release.published`

`webhook.test` is reserved for an explicit test delivery and is not a subscription event.

## Delivery envelope

Kosh sends JSON similar to:

```json
{
  "deliveryId": "uuid",
  "event": "push",
  "repositoryId": "repository-id",
  "sentAt": "2026-10-03T00:00:00.000Z",
  "version": "2026-10-03",
  "payload": {}
}
```

Headers:

- `User-Agent: Kosh-Webhooks/2.0`
- `X-Kosh-Event`
- `X-Kosh-Delivery`
- `X-Kosh-Hook-Id`
- `X-Kosh-Attempt`
- `X-Kosh-Signature-256`

The signature format is:

```text
sha256=<hex HMAC-SHA256 of the exact request body>
```

Receivers should compute HMAC-SHA256 using the endpoint signing secret and compare signatures using a constant-time comparison.

## Retry policy

Kosh retries transient failures only. Retryable conditions are:

- network/timeout failure
- HTTP 408
- HTTP 409
- HTTP 425
- HTTP 429
- HTTP 5xx

Other 4xx responses are treated as terminal for that delivery.

Retries use bounded exponential delay inside the configured attempt limit. Each attempt records status, duration and failure reason. Response bodies are not persisted.

## Durable delivery history

Each outbound send creates a durable `webhook` platform resource with `kind: delivery`. The record contains:

- endpoint ID
- delivery ID
- event
- original Kosh payload for controlled redelivery
- destination URL used for the delivery
- per-attempt status/error/duration
- final state
- completion timestamp

Delivery resources are pruned to `KOSH_WEBHOOK_DELIVERY_RETENTION` newest repository deliveries.

Endpoint resources maintain summary health fields including last delivery time, last status and consecutive failures.

## API

Repository root:

```text
/v1/kosh/repos/<namespace>/<repository>/webhooks
```

Operations:

```text
GET    /webhooks
POST   /webhooks
GET    /webhooks/<endpoint-id>
PATCH  /webhooks/<endpoint-id>
DELETE /webhooks/<endpoint-id>
POST   /webhooks/<endpoint-id>/test
POST   /webhooks/<endpoint-id>/rotate-secret
GET    /webhooks/<endpoint-id>/deliveries
POST   /webhooks/<endpoint-id>/deliveries/<delivery-resource-id>/redeliver
```

Create body:

```json
{
  "name": "Production listener",
  "url": "https://integrations.example.net/kosh",
  "events": ["push", "release.published"],
  "active": true
}
```

Creation returns `signingSecret` exactly once for that generated value. Rotating the secret returns the replacement value once.

## Workspace

The repository integrations workspace is:

```text
/apps/kosh/webhooks?namespace=<namespace>&slug=<repository>
```

It supports endpoint creation, event subscription, test delivery, enable/disable, secret rotation, delivery history, redelivery and deletion.

## Production configuration

```text
KOSH_WEBHOOK_TIMEOUT_MS=8000
KOSH_WEBHOOK_MAX_ATTEMPTS=3
KOSH_WEBHOOK_DELIVERY_RETENTION=500
KOSH_WEBHOOK_BLOCK_PRIVATE_NETWORKS=true
```

The signing secret encryption depends on the existing production `KOSH_MASTER_KEY` requirement.

## Operational notes

The current dispatcher runs as part of Kosh event handling. It has bounded timeout/retry behavior, but it is not yet a separately scaled asynchronous message broker. A future queue/worker implementation can preserve the same endpoint, envelope, delivery and redelivery contracts without changing receiver integrations.
