# API Reference

Complete API documentation for vpnVPN services.

---

## Table of Contents

1. [Control Plane API](#control-plane-api)
2. [Web App REST API](#web-app-rest-api)
3. [tRPC API](#trpc-api)

---

## Control Plane API

**Base URL:** `https://vpnvpn-control-plane-staging.up.railway.app` (single Railway deployment; a custom domain is optional and requires a paid Railway plan)

### Authentication

| Method       | Header                          | Description                 |
| ------------ | ------------------------------- | --------------------------- |
| Bearer Token | `Authorization: Bearer <token>` | For VPN node authentication |
| API Key      | `x-api-key: <key>`              | For web app authentication  |

---

### Health Check

Check service health and database connectivity.

```
GET /health
```

**Authentication:** None

**Response:**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "control-plane",
  "checks": {
    "database": {
      "status": "ok",
      "latencyMs": 5
    }
  }
}
```

**Status Codes:**

| Code | Description                                    |
| ---- | ---------------------------------------------- |
| 200  | Service healthy                                |
| 503  | Service unhealthy (database connection failed) |

---

### Server Registration

Register or update a VPN server node.

```
POST /server/register
```

**Authentication:** Bearer Token

**Request Body:**

```json
{
  "id": "vpn-us-east-1-001",
  "publicKey": "base64-encoded-wireguard-public-key",
  "listenPort": 51820,
  "metadata": {
    "region": "us-east-1",
    "country": "US",
    "provider": "aws"
  }
}
```

| Field                 | Type   | Required | Description                            |
| --------------------- | ------ | -------- | -------------------------------------- |
| `id`                  | string | Yes      | Unique server identifier               |
| `publicKey`           | string | Yes      | WireGuard public key                   |
| `listenPort`          | number | Yes      | WireGuard listen port                  |
| `metadata`            | object | No       | Additional server metadata             |
| `wgEndpoint`          | string | No       | WireGuard endpoint (host)              |
| `wgPort`              | number | No       | WireGuard port                         |
| `ovpnEndpoint`        | string | No       | OpenVPN endpoint (host)                |
| `ovpnPort`            | number | No       | OpenVPN port                           |
| `ovpnCaBundle`        | string | No       | OpenVPN CA certificate (PEM)           |
| `ovpnPeerFingerprint` | string | No       | OpenVPN server certificate fingerprint |
| `ikev2Remote`         | string | No       | IKEv2 remote address (host:port)       |

**Response:**

```json
{
  "status": "registered"
}
```

**Status Codes:**

| Code | Description                     |
| ---- | ------------------------------- |
| 200  | Successfully registered         |
| 401  | Invalid or missing bearer token |
| 400  | Invalid request body            |

---

### Get Peers for Server

Fetch active peers assigned to a VPN server.

```
GET /server/peers?id=<server-id>
```

**Authentication:** Bearer Token

**Query Parameters:**

| Parameter | Type   | Required | Description                                        |
| --------- | ------ | -------- | -------------------------------------------------- |
| `id`      | string | No       | Server ID to filter peers (returns all if omitted) |

**Response:**

```json
{
  "peers": [
    {
      "public_key": "client-wireguard-public-key",
      "preshared_key": null,
      "allowed_ips": ["10.8.0.2/32"],
      "endpoint": null,
      "username": "ovpn-user",
      "password": "ovpn-pass"
    }
  ]
}
```

> **Note:** `username` and `password` are included for OpenVPN authentication.

**Status Codes:**

| Code | Description                     |
| ---- | ------------------------------- |
| 200  | Success                         |
| 401  | Invalid or missing bearer token |

---

### List All Servers

Get a list of all registered VPN servers with metrics.

```
GET /servers
```

**Authentication:** API Key (`x-api-key` header)

**Response:**

```json
[
  {
    "id": "vpn-us-east-1-001",
    "publicIp": "54.123.45.67",
    "metadata": {
      "region": "us-east-1",
      "country": "US"
    },
    "metrics": {
      "sessions": 42,
      "cpu": 15.5,
      "memory": 45.2
    },
    "status": "online",
    "lastSeen": "2024-01-15T10:30:00.000Z",
    "country": "US",
    "region": "us-east-1"
  }
]
```

**Status Codes:**

| Code | Description                |
| ---- | -------------------------- |
| 200  | Success                    |
| 401  | Invalid or missing API key |

---

### Create/Update Peer

Add a new peer or update existing peer configuration.

```
POST /peers
```

**Authentication:** API Key (`x-api-key` header)

**Request Body:**

```json
{
  "publicKey": "client-wireguard-public-key",
  "userId": "user-id-from-database",
  "allowedIps": ["10.8.0.5/32"],
  "serverId": "vpn-us-east-1-001",
  "country": "US",
  "region": "us-east-1"
}
```

| Field        | Type     | Required | Description                       |
| ------------ | -------- | -------- | --------------------------------- |
| `publicKey`  | string   | Yes      | Client WireGuard public key       |
| `userId`     | string   | Yes      | User ID from web app database     |
| `allowedIps` | string[] | Yes      | Allowed IP ranges for client      |
| `serverId`   | string   | No       | Preferred server ID               |
| `country`    | string   | No       | Country code                      |
| `region`    | string   | No       | AWS region                        |
| `username`   | string   | No       | OpenVPN username (auto-generated) |
| `password`   | string   | No       | OpenVPN password (auto-generated) |

**Note:** Creating a new peer automatically revokes any existing active peers for the same user. The revoke and create run inside a single database transaction, so concurrent requests cannot both create a peer.

**Response:** `204 No Content`

**Status Codes:**

| Code | Description                                  |
| ---- | -------------------------------------------- |
| 204  | Peer created/updated                         |
| 400  | Invalid request body                         |
| 401  | Invalid or missing API key                   |
| 409  | A peer with the same `publicKey` already exists |

---

### Revoke Peers for User

Revoke all active peers for a specific user.

```
POST /peers/revoke-for-user
```

**Authentication:** API Key (`x-api-key` header)

**Request Body:**

```json
{
  "userId": "user-id-from-database"
}
```

**Response:** `204 No Content`

**Status Codes:**

| Code | Description                |
| ---- | -------------------------- |
| 204  | Peers revoked              |
| 400  | Invalid request body       |
| 401  | Invalid or missing API key |

---

### Revoke Peer by Public Key

Revoke a specific peer by its public key.

```
DELETE /peers/:publicKey
```

**Authentication:** API Key (`x-api-key` header)

**URL Parameters:**

| Parameter   | Description                      |
| ----------- | -------------------------------- |
| `publicKey` | URL-encoded WireGuard public key |

**Response:** `204 No Content`

**Status Codes:**

| Code | Description                |
| ---- | -------------------------- |
| 204  | Peer revoked               |
| 400  | Peer not found             |
| 401  | Invalid or missing API key |

---

### Delete Server

Delete a VPN server from the control plane.

```
DELETE /servers/:id
```

**Authentication:** API Key (`x-api-key` header)

**URL Parameters:**

| Parameter | Description                 |
| --------- | --------------------------- |
| `id`      | Server identifier to delete |

**Response:** `204 No Content`

**Status Codes:**

| Code | Description                |
| ---- | -------------------------- |
| 204  | Server deleted             |
| 404  | Server not found           |
| 401  | Invalid or missing API key |

---

### List Tokens

List all VPN node authentication tokens.

```
GET /tokens
```

**Authentication:** API Key (`x-api-key` header)

**Response:**

```json
[
  {
    "token": "abc123...",
    "label": "production-node-1",
    "active": true,
    "usageCount": 42,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "scope": "user"
  }
]
```

**Status Codes:**

| Code | Description                |
| ---- | -------------------------- |
| 200  | Success                    |
| 401  | Invalid or missing API key |

---

### Create Token

Create a new VPN node authentication token.

```
POST /tokens
```

**Authentication:** API Key (`x-api-key` header)

**Request Body:**

```json
{
  "label": "new-production-node"
}
```

**Response:**

The raw `token` is returned **exactly once** here and is never recoverable
afterwards — only its SHA-256 hash is stored. Subsequent listings expose only
`tokenPrefix` (the first 8 characters) for display.

```json
{
  "id": "ckv...",
  "token": "generated-secure-token...",
  "tokenPrefix": "a1b2c3d4",
  "label": "new-production-node",
  "active": true,
  "usageCount": 0,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "scope": "user"
}
```

**Status Codes:**

| Code | Description                |
| ---- | -------------------------- |
| 201  | Token created              |
| 400  | Invalid request body       |
| 401  | Invalid or missing API key |

---

### Revoke Token

Revoke a VPN node authentication token, identified by its `id` (the raw token
value is not stored and cannot be used here).

```
DELETE /tokens/:id
```

**Authentication:** API Key (`x-api-key` header)

**URL Parameters:**

| Parameter | Description        |
| --------- | ------------------ |
| `id`      | Token id to revoke |

**Response:**

```json
{
  "id": "ckv...",
  "tokenPrefix": "a1b2c3d4",
  "label": "node-label",
  "active": false,
  "usageCount": 10,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "scope": "user"
}
```

**Status Codes:**

| Code | Description                |
| ---- | -------------------------- |
| 200  | Token revoked              |
| 404  | Token not found            |
| 401  | Invalid or missing API key |

---

### Create Token (alias)

`POST /admin/tokens` is an alias of `POST /tokens` with identical behavior,
authentication, and request/response shape. It exists so admin tooling can use a
consistent `/admin/*` prefix.

---

### Revoke Token (alias)

`DELETE /admin/tokens/:id` is an alias of `DELETE /tokens/:id` with
identical behavior, authentication, and request/response shape.

---

### Ingest VPN Metrics

Submit metrics from a VPN server node. Metrics ingestion lives in the control
plane (there is no separate metrics service); ingested rows are stored in the
`VpnMetric` table for dashboard views.

```
POST /metrics/vpn
```

**Authentication:** Bearer token (VPN node token), via
`Authorization: Bearer <token>` — the same token used for `/server/register`.
Requests without a valid, active node token are rejected with `401`. Also rate
limited (20 req/min).

**Request Body:**

```json
{
  "serverId": "vpn-us-east-1-001",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "cpu": 15.5,
  "memory": 45.2,
  "activePeers": 42,
  "region": "us-east-1"
}
```

| Field         | Type   | Required | Description                          |
| ------------- | ------ | -------- | ------------------------------------ |
| `serverId`    | string | Yes      | Server identifier                    |
| `timestamp`   | string | No       | ISO 8601 timestamp (defaults to now) |
| `cpu`         | number | No       | CPU usage percentage                 |
| `memory`      | number | No       | Memory usage percentage              |
| `activePeers` | number | No       | Number of active peer connections    |
| `region`      | string | No       | Region label                         |

**Response:**

```json
{
  "status": "accepted"
}
```

**Status Codes:**

| Code | Description          |
| ---- | -------------------- |
| 202  | Metrics accepted     |
| 400  | Invalid request body |

---

### Prometheus Service Discovery

Return the currently-online nodes as Prometheus HTTP service-discovery targets so
Prometheus auto-discovers the fleet. Each node's scrape address is derived as
`<publicIp>:METRICS_TARGET_PORT` (default `8080`, the node `ADMIN_PORT`). Only
servers with a `publicIp` seen within the last 5 minutes are returned.

```
GET /metrics/targets
```

**Authentication:** API key — accepted via either `x-api-key: <key>` or
`Authorization: Bearer <key>` (Prometheus http_sd uses the latter).

**Response:**

```json
[
  {
    "targets": ["54.123.45.67:8080"],
    "labels": { "node": "vpn-us-east-1-001", "region": "us-east-1", "country": "US" }
  }
]
```

**Status Codes:**

| Code | Description                                  |
| ---- | -------------------------------------------- |
| 200  | Success                                      |
| 401  | Invalid or missing credentials               |
| 500  | `CONTROL_PLANE_API_KEY` not configured / error |

---

## Web App REST API

**Base URL:** `https://vpnvpn.dev` (production) or `https://staging.vpnvpn.dev` (staging)

### Health Check

```
GET /api/health
```

**Authentication:** None

**Response:**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "web",
  "checks": {
    "database": {
      "status": "ok",
      "latencyMs": 5
    },
    "controlPlane": {
      "status": "ok",
      "latencyMs": 50
    }
  }
}
```

**Status Values:**

| Status      | Description                             |
| ----------- | --------------------------------------- |
| `healthy`   | All systems operational                 |
| `degraded`  | Non-critical service unavailable        |
| `unhealthy` | Critical service (database) unavailable |

---

### Desktop Connect

Register a device and get WireGuard configuration (for desktop app).

```
POST /api/desktop/connect
```

**Authentication:** Session cookie (NextAuth)

**Headers:**

| Header              | Description                  |
| ------------------- | ---------------------------- |
| `x-vpn-private-key` | Client WireGuard private key |

**Request Body:**

```json
{
  "publicKey": "client-wireguard-public-key",
  "deviceName": "My MacBook",
  "serverId": "vpn-us-east-1-001"
}
```

**Response:**

```json
{
  "config": "[Interface]\nPrivateKey = ...\nAddress = 10.8.0.5/32\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = ...\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = vpn.vpnvpn.com:51820\n"
}
```

**Error Responses:**

| Code | Error                 | Description                           |
| ---- | --------------------- | ------------------------------------- |
| 401  | `unauthenticated`     | No valid session                      |
| 402  | `payment_required`    | No active subscription                |
| 400  | `missing_keys`        | Missing public or private key         |
| 403  | `device_limit`        | Device limit reached                  |
| 500  | `control_plane_error` | Failed to register with control plane |

---

### Stripe Webhook

Handle Stripe billing events.

```
POST /api/webhooks/stripe
```

**Authentication:** Stripe signature (`stripe-signature` header)

**Handled Events:**

| Event                           | Action                                     |
| ------------------------------- | ------------------------------------------ |
| `checkout.session.completed`    | Create subscription, send welcome email    |
| `customer.subscription.created` | Create/update subscription record          |
| `customer.subscription.updated` | Update subscription status/tier            |
| `customer.subscription.deleted` | Revoke VPN access, send cancellation email |

**Response:**

```json
{
  "received": true
}
```

---

## tRPC API

**Base URL:** `/api/trpc` (via Next.js API routes)

All tRPC procedures use SuperJSON transformer for type-safe data serialization.

### Procedure Types

| Type                 | Description                    |
| -------------------- | ------------------------------ |
| `publicProcedure`    | No authentication required     |
| `protectedProcedure` | Requires authenticated session |
| `paidProcedure`      | Requires active subscription   |
| `adminProcedure`     | Requires admin role            |

---

### Device Router (`device.*`)

#### `device.list`

**Type:** Query (paidProcedure)

**Description:** List all devices for the current user.

**Response:**

```typescript
Array<{
  id: string;
  userId: string;
  publicKey: string;
  name: string;
  serverId: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;
```

---

#### `device.register`

**Type:** Mutation (paidProcedure)

**Description:** Register a new device and generate WireGuard config.

**Input:**

```typescript
{
  name: string;        // Device name (min 1 char)
  serverId?: string;   // Optional server preference
}
```

**Response:**

```typescript
{
  deviceId: string;
  assignedIp: string;
  publicKey: string;
  privateKey: string;
}
```

**Errors:**

| Code                    | Message                           |
| ----------------------- | --------------------------------- |
| `FORBIDDEN`             | Device limit reached              |
| `INTERNAL_SERVER_ERROR` | Control plane registration failed |

---

#### `device.revoke`

**Type:** Mutation (paidProcedure)

**Description:** Revoke and delete a device.

**Input:**

```typescript
{
  deviceId: string;
}
```

**Response:**

```typescript
{
  success: true;
}
```

---

### Billing Router (`billing.*`)

#### `billing.createCheckoutSession`

**Type:** Mutation (protectedProcedure)

**Description:** Create a Stripe Checkout session for subscription.

**Input:**

```typescript
{
  priceId?: string;  // Optional, defaults to Pro tier
}
```

**Response:**

```typescript
{
  url: string; // Stripe Checkout URL
}
```

---

#### `billing.createPortalSession`

**Type:** Mutation (protectedProcedure)

**Description:** Create a Stripe Customer Portal session.

**Response:**

```typescript
{
  url: string; // Stripe Portal URL
}
```

---

### Servers Router (`servers.*`)

#### `servers.list`

**Type:** Query (paidProcedure)

**Description:** List available VPN servers with status.

**Response:**

```typescript
Array<{
  id: string;
  region: string;
  country?: string;
  status: "online" | "offline" | "unknown";
  sessions: number;
  cpu?: number;
  lastSeen?: string;
}>;
```

---

### Account Router (`account.*`)

#### `account.get`

**Type:** Query (protectedProcedure)

**Description:** Get account details including subscription and preferences.

**Response:**

```typescript
{
  subscription: {
    id: string;
    stripeSubscriptionId: string;
    status: string;
    tier: "basic" | "pro" | "enterprise";
    currentPeriodEnd: Date | null;
  } | null;
  user: {
    name: string | null;
    email: string | null;
  } | null;
  notificationPreferences: {
    marketing: boolean;
    transactional: boolean;
    security: boolean;
  } | null;
}
```

---

#### `account.updateProfile`

**Type:** Mutation (protectedProcedure)

**Description:** Update user profile.

**Input:**

```typescript
{
  name?: string | null;  // 1-255 characters
}
```

**Response:**

```typescript
{
  success: true;
}
```

---

#### `account.updateNotifications`

**Type:** Mutation (protectedProcedure)

**Description:** Update notification preferences.

**Input:**

```typescript
{
  marketing: boolean;
  transactional: boolean;
  security: boolean;
}
```

**Response:**

```typescript
{
  success: true;
}
```

---

### Admin Router (`admin.*`)

#### `admin.listServers`

**Type:** Query (adminProcedure)

**Description:** List all VPN servers (admin view).

**Response:** Same as `servers.list` but includes all servers regardless of status.

---

#### `admin.listTokens`

**Type:** Query (adminProcedure)

**Description:** List all VPN node tokens.

**Response:**

```typescript
Array<{
  token: string;
  label: string;
  active: boolean;
  usageCount: number;
  createdAt: Date;
}>;
```

---

#### `admin.createToken`

**Type:** Mutation (adminProcedure)

**Description:** Create a new VPN node token.

**Input:**

```typescript
{
  label: string; // Min 1 character
}
```

**Response:**

```typescript
{
  token: string;
  label: string;
}
```

---

#### `admin.revokeToken`

**Type:** Mutation (adminProcedure)

**Description:** Revoke a VPN node token.

**Input:**

```typescript
{
  token: string;
}
```

**Response:**

```typescript
{
  success: true;
}
```

---

### Desktop Router (`desktop.*`)

#### `desktop.resolveCode`

**Type:** Mutation (publicProcedure)

**Description:** Resolve a 6-digit desktop login code to auth URL.

**Input:**

```typescript
{
  email: string; // Valid email
  code: string; // 6 characters
}
```

**Response:**

```typescript
{ ok: true; url: string; } | { ok: false; }
```

---

### Analytics Router (`analytics.*`)

All `analytics.*` procedures are `adminProcedure` (require admin role).

#### `analytics.summary`

**Type:** Query (adminProcedure)

**Description:** Summary statistics across users, subscriptions, and devices.

**Response:**

```typescript
{
  totalUsers: number;
  activeSubscriptions: number;
  totalDevices: number;
  tierBreakdown: Record<string, number>; // active subscriptions by tier
  recentSignups: number;                 // users created in the last 7 days
}
```

---

#### `analytics.historicalMetrics`

**Type:** Query (adminProcedure)

**Description:** Time-bucketed historical VPN metrics (sessions, CPU, memory).

**Input:**

```typescript
{
  period?: "24h" | "7d" | "30d"; // default "24h"
}
```

**Response:**

```typescript
Array<{
  timestamp: string; // ISO 8601 bucket start
  sessions: number;
  avgCpu: number;
  avgMemory: number;
}>;
```

---

#### `analytics.geoDistribution`

**Type:** Query (adminProcedure)

**Description:** Server and session counts grouped by region.

**Response:**

```typescript
Array<{
  region: string;
  servers: number;
  sessions: number;
}>;
```

---

#### `analytics.serverHealth`

**Type:** Query (adminProcedure)

**Description:** Fleet health overview (a server is `offline` when not seen for >5
minutes, `degraded` when CPU >90% or memory >0.9, otherwise `online`).

**Response:**

```typescript
{
  online: number;
  offline: number;
  degraded: number;
  total: number;
}
```

---

#### `analytics.recentActivity`

**Type:** Query (adminProcedure)

**Description:** The 10 most recent devices and subscriptions.

**Response:**

```typescript
{
  recentDevices: Array<{
    id: string;
    name: string;
    email: string;
    createdAt: string;
  }>;
  recentSubscriptions: Array<{
    id: string;
    tier: string;
    status: string;
    email: string;
    createdAt: string;
  }>;
}
```

---

## Error Handling

### tRPC Error Codes

| Code                    | HTTP Status | Description              |
| ----------------------- | ----------- | ------------------------ |
| `UNAUTHORIZED`          | 401         | Not authenticated        |
| `FORBIDDEN`             | 403         | Insufficient permissions |
| `NOT_FOUND`             | 404         | Resource not found       |
| `BAD_REQUEST`           | 400         | Invalid input            |
| `INTERNAL_SERVER_ERROR` | 500         | Server error             |

### Rate Limits

The Control Plane API enforces per-IP rate limits. Exceeding a limit returns
`429 Too Many Requests`.

| Endpoint Category     | Limit       | Examples                                                                                  |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| Read operations       | 100 req/min | `GET /servers`, `GET /server/peers`, `GET /tokens`, `GET /metrics/targets` (global default) |
| Write operations      | 20 req/min  | `POST /peers`, `POST /peers/revoke-for-user`, `DELETE /peers/:publicKey`, `DELETE /servers/:id`, `POST /metrics/vpn` |
| Authentication/tokens | 10 req/min  | `POST /server/register`, `POST /tokens` (+ `/admin/tokens` alias), `DELETE /tokens/:id` (+ `/admin/tokens/:id` alias) |

> **Note:** `GET /health` is exempt from rate limiting so liveness and readiness probes are never throttled.

See `docs/OPERATIONS.md` for error resolution guidance.
