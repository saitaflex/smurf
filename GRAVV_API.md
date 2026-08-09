# Gravv API — Sandbox Reference (discovered live from the API)

> Everything below was probed **directly against `https://api.gravv.xyz`** on
> 2026-08-09 using your sandbox keys. No docs login was used — the endpoints,
> field names, and enums were extracted from the server's own validation errors.
> No money was moved (the account is `frozen`, so transfers stop at validation).

## 1. Keys & how they authenticate
| Key | Value | Header | Role |
|-----|-------|--------|------|
| **Secret** | `grvSec_sandbox_0c17f6a2d01640f5b7f69a912bb3a0270c17f6a2d016DeJnqv` | `Api-Key:` | Server-side, full access. Never expose. |
| **Public** | `grvPub_sandbox_7866184617bf433cababb6fbc51bf8727866184617bf2OGjX1` | `X-Client-Public-Key:` | Client identifier, safe for front-end. |

**Always-required headers**
- `Api-Key: <secret>`
- `X-Client-Public-Key: <public>`
- `X-Environment: sandbox`
- `Content-Type: application/json`
- `Idempotency-Key: <unique-per-request>` — **required on every POST** (missing it = 400).

**Base URL:** `https://api.gravv.xyz` · **Version prefix:** `/v1`
**Response envelope (all endpoints):** `{ "data": ..., "error": ... }`

## 2. What Gravv actually is (confirmed from live data)
A **stablecoin payment/payout rail**. Accounts hold crypto assets on **Polygon**:
`USDC` (6 dp), `USDT` (6 dp), `POL` (18 dp). Each account has a `wallet_address`,
`capabilities: [transfer, receive]`, and belongs to a tenant (yours: **SAITAFLEX**).

## 3. Confirmed endpoints

### Health / status — no auth needed
| Method | Path | Result |
|--------|------|--------|
| GET | `/` | `{"message":"Ping Pong!"}` |
| GET | `/healthz` | `{"status":"healthy","timestamp":...}` |

### Accounts
| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/accounts` | List. Paginated: `?page=1&limit=5`. |
| GET | `/v1/accounts/{id}` | Single account. |

Account fields: `id, customer_id, tenant_id, tenant_name, label, type, category,
currency, balance, assets[], blockchain_network, wallet_address, capabilities[],
inflow_behavior, status, date_created`.

### Wallets
| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/wallets` | List (paginated). |
| GET | `/v1/wallets/{id}` | Single wallet. |
| POST | `/v1/wallets` | Create. Requires `customer_id`. |

Wallet fields: `id, customer_id, address, name, network, date_created`.

### Customers
| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/customers` | List (paginated). |
| GET | `/v1/customers/{id}` | Single customer. |
| POST | `/v1/customers` | Create — schema below. |

**Create customer body:**
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "phone": "+1234567890",
  "type": "individual",
  "address": {
    "address_line1": "1 Main St",
    "city": "New York",
    "postal_code": "10001",
    "state": "NY",
    "country_iso_code": "USA"
  }
}
```
All of the above are **required** (email must be valid; address_line1, city,
postal_code, state, country_iso_code, type, phone all validated).

### Transactions
| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/transactions` | List (paginated). |

### Transfer (send money) — `POST /v1/transfer`
Full required schema (discovered field-by-field):
```json
{
  "customer_id": "<uuid>",
  "client_reference": "your-ref-123",
  "description": "Payout for invoice 42",
  "amount": "10.00",
  "source": {
    "source_type": "internal_account",
    "id": "<account-or-wallet-uuid>"
  },
  "destination": {
    "destination_type": "crypto_wallet",
    "id": "<destination-uuid>"
  }
}
```
`source_type` / `destination_type` enum (exact values):
**`internal_account`**, **`crypto_wallet`**, **`external_account`**, **`card`**.
> With a valid body it reached business validation and returned:
> *"source account … is frozen — transfer not permitted (must be active)"* —
> confirming the schema is correct and no funds moved.

### Collections (receive money) — `POST /v1/collections`
Required: `customer_id` (UUID), `client_customer_id`, `amount`, `currency`,
and a `destination` object (`destination.destination_type`, …).

### Payment links — `/v1/payment-links`
Routes exist (`GET` list, `POST` create) but the server reports
**`not implemented`** in sandbox — not usable yet.

## 4. Copy-paste test calls
```bash
SEC='grvSec_sandbox_0c17f6a2d01640f5b7f69a912bb3a0270c17f6a2d016DeJnqv'
PUB='grvPub_sandbox_7866184617bf433cababb6fbc51bf8727866184617bf2OGjX1'

# List accounts
curl https://api.gravv.xyz/v1/accounts \
  -H "Api-Key: $SEC" -H "X-Client-Public-Key: $PUB" -H "X-Environment: sandbox"

# Create a customer (POST needs Idempotency-Key)
curl -X POST https://api.gravv.xyz/v1/customers \
  -H "Api-Key: $SEC" -H "X-Client-Public-Key: $PUB" \
  -H "X-Environment: sandbox" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"name":"Jane Doe","email":"jane@example.com","phone":"+1234567890","type":"individual","address":{"address_line1":"1 Main St","city":"New York","postal_code":"10001","state":"NY","country_iso_code":"USA"}}'
```

## 5. Notes / gotchas
- **Every POST needs a fresh `Idempotency-Key`** or you get `400 missing idempotency key`.
- Errors come back as `{"data":null,"error":"<message>"}` with HTTP 400.
- Your sandbox account is currently `status: frozen`, so transfers are blocked
  until it's active — that's an account state, not a code problem.
- These keys were shared in chat; sandbox = low risk, but rotate them in the
  Gravv dashboard if this is a real account, and keep the **secret** server-side only.

## 6. Not exposed by the API
- Full docs (`docs.gravv.xyz`) are password-protected; `/v1/payment-links` is
  stubbed. Everything else above is live and verified.
