# W3 BitGo Action — Reference Guide

Custodial-wallet treasury automation against BitGo's platform REST API. 30 commands across session, wallet management, sends, transfers, TSS tx requests, policy + approval, synchronous wait, and webhooks.

## Scope

This action drives **BitGo custodial wallets only** — both signing models (TSS / MPC and on-chain multi-sig). BitGo holds the keys and signs server-side. Hot and cold (self-managed) wallets need BitGo Express running as a sidecar or `@bitgo/sdk-core` bundled in-process; this action fails fast on them with `UNSUPPORTED_WALLET_TYPE` rather than producing confusing API errors.

## Common inputs

These apply to most commands. Command-specific inputs are documented per command below.

| Input            | Required  | Notes                                                                                                                                                                                         |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`        | yes       | One of the commands below.                                                                                                                                                                    |
| `access-token`   | yes       | BitGo access token. Sent as `Authorization: Bearer ...`. Issue from BitGo dashboard → Settings → Developer Options → Access Tokens.                                                           |
| `enterprise-id`  | sometimes | Required for create/list operations scoped to an enterprise. Inherited as a default by `list-wallets`, `list-pending-approvals`, etc.                                                         |
| `api-url`        | no        | Defaults to `https://app.bitgo.com/api/v2`. Use `https://app.bitgo-test.com/api/v2` for the test environment.                                                                                 |
| `correlation-id` | no        | Embedded in the BitGo `comment` field as a `[w3-corr:<id>]` marker so future webhook receivers can match approvals back to the workflow run. The action generates one if you don't supply it. |

## Output shape

Every command produces a single `result` output as a JSON string. Parse with `fromJSON()` and access fields directly:

```yaml
- uses: w3-io/w3-bitgo-action@v0
  id: send
  with:
    command: send-transaction
    # ...

- run: |
    echo "approval id = ${{ fromJSON(steps.send.outputs.result).pendingApprovalId }}"
    echo "correlation = ${{ fromJSON(steps.send.outputs.result).correlationId }}"
```

## Errors

All errors are `BitGoError` with a stable code prefix. The most common:

| Code                                                             | Meaning                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `MISSING_ACCESS_TOKEN`, `MISSING_COIN`, `MISSING_WALLET_ID`, ... | Required input not provided.                                                            |
| `BITGO_UNAUTHORIZED`                                             | Token rejected (401/403). Check rotation, scope, and environment match.                 |
| `NEEDS_UNLOCK`                                                   | Sensitive op called before `unlock` or after the unlock window expired.                 |
| `INSUFFICIENT_BALANCE`                                           | Not enough spendable balance for the requested send.                                    |
| `POLICY_VIOLATION`                                               | BitGo's policy engine denied the request. Inspect `result.raw` for the rule that fired. |
| `UNSUPPORTED_WALLET_TYPE`                                        | Wallet is not custodial — use BitGo Express or wait for the SDK-based action.           |
| `UNSUPPORTED_MULTISIG_TYPE`                                      | `multisigType` is not `tss` or `onchain` (e.g. `blsdkg` for ETH2 validators).           |
| `BITGO_API_ERROR`                                                | Catch-all. Set `BITGO_DEBUG=1` locally to see the full BitGo response body.             |

---

## Session

### `unlock`

Unlock the BitGo session for sensitive operations. Required before any send, policy mutation, or approval action. Test environment accepts the magic OTP `000000`; production needs a real TOTP from the user's authenticator.

The recommended pattern is to chain a native `crypto: totp` step before the unlock so the TOTP secret stays inside the protocol's secret resolver. See the [payroll cookbook recipe](https://github.com/w3-io/w3-mcp/blob/main/content/cookbook/bitgo-payroll-totp.md) for the full pattern.

| Input      | Required | Description                                                      |
| ---------- | -------- | ---------------------------------------------------------------- |
| `otp`      | yes      | Six-digit TOTP code valid for the current 30s window.            |
| `duration` | no       | Unlock duration in seconds. Default 600. BitGo caps around 3600. |

**Output:** `{ session: { id, scope, expires, ... } }` — the session object BitGo returns.

---

## Tier 1 — Wallet management

### `list-wallets`

| Input           | Required | Description                                |
| --------------- | -------- | ------------------------------------------ |
| `coin`          | yes      | Coin ticker (e.g. `btc`, `hteth`, `tsol`). |
| `enterprise-id` | no       | Defaults to the constructor enterprise ID. |
| `limit`         | no       | Max wallets per page.                      |
| `prev-id`       | no       | Pagination cursor.                         |

**Output:** `{ wallets: [...], coin }`.

### `get-wallet`

| Input       | Required | Description  |
| ----------- | -------- | ------------ |
| `coin`      | yes      | Coin ticker. |
| `wallet-id` | yes      | Wallet ID.   |

**Output:** Full BitGo wallet metadata. Notable fields: `type` (custodial/hot/cold), `multisigType` (tss/onchain), `balanceString`, `spendableBalanceString`, `receiveAddress`, `admin.policy.rules`.

### `create-wallet`

Create a new wallet. The wallet creation schema is rich and varies per coin, so the action accepts a passthrough JSON body.

| Input           | Required | Description                                                                         |
| --------------- | -------- | ----------------------------------------------------------------------------------- |
| `coin`          | yes      | Coin ticker.                                                                        |
| `body`          | yes      | JSON wallet creation parameters. The action injects `enterprise-id` if not present. |
| `enterprise-id` | no       | Defaults to the constructor enterprise ID.                                          |

**Output:** The created wallet object.

### `delete-wallet`

Permanently delete a wallet. This is a destructive operation -- ensure the wallet has been drained first.

| Input       | Required | Description  |
| ----------- | -------- | ------------ |
| `coin`      | yes      | Coin ticker. |
| `wallet-id` | yes      | Wallet ID.   |

**Output:** Deletion confirmation from BitGo.

### `share-wallet`

| Input               | Required | Description                                            |
| ------------------- | -------- | ------------------------------------------------------ |
| `coin`              | yes      | Coin ticker.                                           |
| `wallet-id`         | yes      | Wallet ID.                                             |
| `share-with-user`   | yes      | BitGo user ID to share with.                           |
| `share-permissions` | yes      | Comma-separated permissions: `view`, `spend`, `admin`. |

### `freeze-wallet`

| Input       | Required | Description                                                            |
| ----------- | -------- | ---------------------------------------------------------------------- |
| `coin`      | yes      | Coin ticker.                                                           |
| `wallet-id` | yes      | Wallet ID.                                                             |
| `body`      | no       | Optional JSON body, e.g. `{"duration": 3600}` for a time-bound freeze. |

### `get-balance`

| Input       | Required | Description  |
| ----------- | -------- | ------------ |
| `coin`      | yes      | Coin ticker. |
| `wallet-id` | yes      | Wallet ID.   |

**Output:** `{ coin, walletId, balance, confirmedBalance, spendableBalance }` — base-unit string projections from the wallet metadata.

### `list-addresses`

| Input       | Required | Description             |
| ----------- | -------- | ----------------------- |
| `coin`      | yes      | Coin ticker.            |
| `wallet-id` | yes      | Wallet ID.              |
| `limit`     | no       | Max addresses per page. |
| `prev-id`   | no       | Pagination cursor.      |

**Output:** `{ addresses: [...], totalAddressCount, ... }`.

### `create-address`

Mint a new receive address on a wallet.

| Input       | Required | Description                       |
| ----------- | -------- | --------------------------------- |
| `coin`      | yes      | Coin ticker.                      |
| `wallet-id` | yes      | Wallet ID.                        |
| `label`     | no       | Human-readable label.             |
| `chain`     | no       | Address chain index (UTXO coins). |

**Output:** The created address object including `id`, `address`, and `coinSpecific` fields.

### `maximum-spendable`

Compute the maximum amount the wallet can drain in a single transaction after fees. Useful for "send max" workflows.

| Input       | Required | Description             |
| ----------- | -------- | ----------------------- |
| `coin`      | yes      | Coin ticker.            |
| `wallet-id` | yes      | Wallet ID.              |
| `fee-rate`  | no       | Optional fee rate hint. |

**Output:** `{ maximumSpendable, coin }`.

### `fee-estimate`

Current network fee rates BitGo recommends for the coin.

| Input  | Required | Description  |
| ------ | -------- | ------------ |
| `coin` | yes      | Coin ticker. |

**Output:** Coin-specific fee structure (EVM: `feePerKb`, `gasPrice`, EIP-1559 fields; UTXO: per-block-target sat/vB).

---

## Tier 2 — Sends and tx queries

### `send-transaction`

Custodial send. Auto-detects the wallet's signing model and dispatches:

- **TSS** → `POST /wallet/:id/txrequests` with the nested intent shape
- **Multi-sig (onchain)** → `POST /:coin/wallet/:id/tx/initiate` with a flat recipients array

Supports **single-recipient sends** (the `address`+`amount` shortcut) and **batch sends** (a `recipients` JSON array). Both shapes work on both wallet types.

Supports **token sends** transparently: pass the token coin code as `coin` (e.g. `hteth:tusdc` for Holesky test USDC, `eth:usdc` for mainnet ERC-20 USDC). The action routes to the right token endpoint and propagates the symbol into the TSS intent. No new command needed.

Token batch sends use BitGo's batcher contract under the hood, which requires a one-time on-chain approval per token before it can be used. The first attempt at a token batch will surface `INSUFFICIENT_BALANCE: Insufficient token allowance for batcher contract` — approve the batcher in the BitGo dashboard, then retry.

Both paths produce a `pendingApproval` that BitGo's signing infrastructure resolves async. The result is a uniform pending-approval shape regardless of which underlying flow ran.

| Input                         | Required    | Description                                                                                                                                           |
| ----------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coin`                        | yes         | Coin ticker. For tokens, use the BitGo token code (e.g. `hteth:tusdc`, `eth:usdc`).                                                                   |
| `wallet-id`                   | yes         | Wallet ID.                                                                                                                                            |
| `address`                     | conditional | Destination address (single-recipient shortcut).                                                                                                      |
| `amount`                      | conditional | Amount in base units (single-recipient shortcut).                                                                                                     |
| `recipients`                  | conditional | JSON array `[{"address":"0x...","amount":"1000"},...]` for batch sends. Mutually exclusive with `address`+`amount` — when provided, takes precedence. |
| `comment`                     | no          | Free-form comment. The action appends `[w3-corr:<id>]` automatically.                                                                                 |
| `sequence-id`                 | no          | Client sequence ID for idempotent sends.                                                                                                              |
| `correlation-id`              | no          | Workflow correlation ID. Auto-generated UUID if omitted.                                                                                              |
| `register-webhook-on-pending` | no          | If `"true"` and the send returns a pending approval, auto-register a webhook against `webhook-url` for Layer 3 async continuation.                    |
| `webhook-url`                 | no          | Required when `register-webhook-on-pending` is `"true"`.                                                                                              |

#### Examples

Single recipient, native coin:

```yaml
- uses: w3-io/w3-bitgo-action@v0
  with:
    command: send-transaction
    access-token: ${{ secrets.BITGO_ACCESS_TOKEN }}
    coin: hteth
    wallet-id: ${{ secrets.BITGO_WALLET_ID }}
    address: '0x...'
    amount: '1000000000000000'
```

Single recipient, ERC-20 token:

```yaml
- uses: w3-io/w3-bitgo-action@v0
  with:
    command: send-transaction
    access-token: ${{ secrets.BITGO_ACCESS_TOKEN }}
    coin: hteth:tusdc # token code, not native eth
    wallet-id: ${{ secrets.BITGO_WALLET_ID }}
    address: '0x...'
    amount: '1000000' # USDC has 6 decimals
```

Batch send (payroll, distribution):

```yaml
- uses: w3-io/w3-bitgo-action@v0
  with:
    command: send-transaction
    access-token: ${{ secrets.BITGO_ACCESS_TOKEN }}
    coin: hteth
    wallet-id: ${{ secrets.BITGO_WALLET_ID }}
    recipients: |
      [
        {"address": "0xAlice", "amount": "5000000000000000000"},
        {"address": "0xBob",   "amount": "3000000000000000000"},
        {"address": "0xCarol", "amount": "2000000000000000000"}
      ]
    correlation-id: payroll-2026-04
```

**Output:**

```jsonc
{
  "status": "pending-approval",
  "pendingApprovalId": "69da0b69be4ef029a9af54692439ee00", // multi-sig path
  "txRequestId": null, // or set on TSS path
  "correlationId": "payroll-2026-04-alice",
  "webhookRegistration": {
    // if register flag was set
    "attempted": true,
    "registered": true,
    "url": "https://example.com/hook",
  },
  "raw": {
    /* full BitGo response */
  },
}
```

If BitGo somehow returns a synchronously-completed send (rare for custodial), the shape collapses to `{ status: "sent", txHash, correlationId, raw }`.

### `get-transaction`

| Input       | Required | Description                                            |
| ----------- | -------- | ------------------------------------------------------ |
| `coin`      | yes      | Coin ticker.                                           |
| `wallet-id` | yes      | Wallet ID.                                             |
| `tx-id`     | yes      | BitGo internal transaction ID (not the on-chain hash). |

### `list-transactions`

| Input       | Required | Description                |
| ----------- | -------- | -------------------------- |
| `coin`      | yes      | Coin ticker.               |
| `wallet-id` | yes      | Wallet ID.                 |
| `limit`     | no       | Max transactions per page. |
| `prev-id`   | no       | Pagination cursor.         |

### `get-transfer`

BitGo's enriched transfer view includes the recipient/value movement and confirmation state.

| Input         | Required | Description  |
| ------------- | -------- | ------------ |
| `coin`        | yes      | Coin ticker. |
| `wallet-id`   | yes      | Wallet ID.   |
| `transfer-id` | yes      | Transfer ID. |

### `list-transfers`

| Input       | Required | Description             |
| ----------- | -------- | ----------------------- |
| `coin`      | yes      | Coin ticker.            |
| `wallet-id` | yes      | Wallet ID.              |
| `limit`     | no       | Max transfers per page. |
| `prev-id`   | no       | Pagination cursor.      |

---

## TSS-specific tx requests

For TSS wallets, every send creates a `txRequest` first (then optionally a pendingApproval). These commands let you query the request queue directly. The endpoint has no coin prefix — BitGo identifies the coin from the wallet ID.

### `get-tx-request`

| Input           | Required | Description        |
| --------------- | -------- | ------------------ |
| `wallet-id`     | yes      | Wallet ID.         |
| `tx-request-id` | yes      | TSS tx request ID. |

### `list-tx-requests`

| Input       | Required | Description |
| ----------- | -------- | ----------- |
| `wallet-id` | yes      | Wallet ID.  |

---

## Tier 3 — Policy and approval

### `list-policies`

Surfaces the policy rules attached to a wallet via the wallet metadata. Cached: this command doesn't make a separate HTTP call if `get-wallet` was called recently in the same action invocation.

| Input       | Required | Description  |
| ----------- | -------- | ------------ |
| `coin`      | yes      | Coin ticker. |
| `wallet-id` | yes      | Wallet ID.   |

**Output:** `{ coin, walletId, version, latest, rules: [...] }`.

### `set-policy-rule`

| Input       | Required | Description                                                                                                              |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `coin`      | yes      | Coin ticker.                                                                                                             |
| `wallet-id` | yes      | Wallet ID.                                                                                                               |
| `body`      | yes      | JSON policy rule definition. BitGo's per-rule-type schema is rich and not modeled by the action — pass it through as-is. |

### `remove-policy-rule`

| Input            | Required | Description        |
| ---------------- | -------- | ------------------ |
| `coin`           | yes      | Coin ticker.       |
| `wallet-id`      | yes      | Wallet ID.         |
| `policy-rule-id` | yes      | Rule ID to remove. |

### `list-pending-approvals`

| Input           | Required | Description                                                      |
| --------------- | -------- | ---------------------------------------------------------------- |
| `wallet-id`     | no       | Filter to one wallet.                                            |
| `enterprise-id` | no       | Filter to one enterprise. Defaults to constructor enterprise ID. |

### `get-pending-approval`

| Input                 | Required | Description          |
| --------------------- | -------- | -------------------- |
| `pending-approval-id` | yes      | Pending approval ID. |

### `approve-pending`

| Input                 | Required | Description                                                                         |
| --------------------- | -------- | ----------------------------------------------------------------------------------- |
| `pending-approval-id` | yes      | Pending approval ID.                                                                |
| `otp`                 | no       | Required for tx-signing approvals. Use the same `crypto: totp` pattern as `unlock`. |

### `reject-pending`

| Input                 | Required | Description          |
| --------------------- | -------- | -------------------- |
| `pending-approval-id` | yes      | Pending approval ID. |

---

## Layer 2 — Synchronous wait

### `wait-for-approval`

Blocks until a pending approval reaches a terminal state (approved or rejected) or the timeout elapses. Polling cadence starts at 5s and exponentially backs off (×1.5) to a 30s ceiling. The first poll happens immediately, so already-resolved approvals return on the first call.

| Input                 | Required | Description                                             |
| --------------------- | -------- | ------------------------------------------------------- |
| `pending-approval-id` | yes      | Pending approval ID.                                    |
| `timeout`             | no       | Polling timeout in seconds. Default 300. Hard cap 3600. |

**Output:**

```jsonc
{
  "status": "approved" | "rejected" | "timeout",
  "pendingApprovalId": "...",
  "txHash": "0x...",        // present when approved AND the underlying op was a tx
  "raw": { /* final approval state */ }
}
```

For long-tail approvals (multi-party manual approval that may take hours), prefer the Layer 3 webhook continuation pattern by setting `register-webhook-on-pending` on the send rather than holding a workflow slot in `wait-for-approval`.

---

## Tier 4 — Webhook registration

### `add-webhook`

| Input          | Required | Description                                                                       |
| -------------- | -------- | --------------------------------------------------------------------------------- |
| `coin`         | yes      | Coin ticker.                                                                      |
| `wallet-id`    | yes      | Wallet ID.                                                                        |
| `webhook-url`  | yes      | HTTPS callback URL.                                                               |
| `webhook-type` | no       | `transfer`, `pendingApproval`, `address_confirmation`. Default `pendingApproval`. |

### `list-webhooks`

| Input       | Required | Description  |
| ----------- | -------- | ------------ |
| `coin`      | yes      | Coin ticker. |
| `wallet-id` | yes      | Wallet ID.   |

### `remove-webhook`

| Input        | Required | Description                                                |
| ------------ | -------- | ---------------------------------------------------------- |
| `coin`       | yes      | Coin ticker.                                               |
| `wallet-id`  | yes      | Wallet ID.                                                 |
| `webhook-id` | yes      | Webhook ID returned from `add-webhook` or `list-webhooks`. |

### `create-webhook`

Alias for `add-webhook`. Same endpoint and behavior -- provided for naming symmetry with `delete-webhook`.

| Input          | Required | Description                                                                       |
| -------------- | -------- | --------------------------------------------------------------------------------- |
| `coin`         | yes      | Coin ticker.                                                                      |
| `wallet-id`    | yes      | Wallet ID.                                                                        |
| `webhook-url`  | yes      | HTTPS callback URL.                                                               |
| `webhook-type` | no       | `transfer`, `pendingApproval`, `address_confirmation`. Default `pendingApproval`. |

### `delete-webhook`

Alias for `remove-webhook`. Same endpoint and behavior -- provided for naming symmetry with `create-webhook`.

| Input        | Required | Description                                                |
| ------------ | -------- | ---------------------------------------------------------- |
| `coin`       | yes      | Coin ticker.                                               |
| `wallet-id`  | yes      | Wallet ID.                                                 |
| `webhook-id` | yes      | Webhook ID returned from `add-webhook` or `list-webhooks`. |

---

## Three-layer approval reactivity

Every send goes through BitGo's `pendingApproval` queue. The action supports three reactivity patterns:

1. **Default** — `send-transaction` returns the approval ID immediately and exits. The workflow can poll later or fire a follow-up workflow when notified.
2. **Synchronous wait** — chain `wait-for-approval` after the send to block until terminal state.
3. **Async webhook** — set `register-webhook-on-pending: true` and supply `webhook-url` on `send-transaction` to auto-register a webhook against the wallet so the resolution fires a follow-up workflow. Best-effort: webhook registration failure surfaces as `webhookRegistration: { attempted: true, registered: false, error }` on the send result rather than throwing.

Pick by latency tolerance: synchronous wait is the simplest but consumes a workflow slot for the polling duration. Async webhook is the right answer when approvals can take hours and the workflow should fire-and-forget.

---

## Authentication

### Access token

Issue from BitGo dashboard → Settings → Developer Options → Access Tokens. Scope it to the minimum permissions you need; the `wallet_spend_all` scope is what unlocks send operations after `unlock`.

For the test environment, issue tokens at `app.bitgo-test.com` and point the action at `https://app.bitgo-test.com/api/v2`. Test-environment tokens do not work against production and vice versa.

### TOTP for unlock and approval

The recommended pattern uses the W3 protocol's native `crypto: totp` syscall to generate the OTP from a protocol-managed secret. The secret never crosses the third-party action boundary:

```yaml
- crypto:
    totp:
      secret: ${{ secrets.BITGO_TOTP_HEX }}
  id: totp

- uses: w3-io/w3-bitgo-action@v0
  with:
    command: unlock
    access-token: ${{ secrets.BITGO_ACCESS_TOKEN }}
    otp: ${{ steps.totp.outputs.code }}
```

**Secret format gotcha:** the bridge route expects the TOTP secret as **hex-encoded bytes**, not base32. BitGo's authenticator setup gives you a base32 string — convert it once when storing the secret:

```bash
echo -n 'JBSWY3DPEHPK3PXP' | base32 -d | xxd -p -c 256
```

Test environment accepts the magic OTP `000000` directly without going through `crypto: totp`.

---

## BitGo Express vs Platform API

BitGo exposes two API surfaces. This action routes every command to the correct one automatically, but understanding the split helps when debugging or reading BitGo's docs.

**Platform API** (`app.bitgo.com/api/v2`) is the hosted service that handles wallet metadata, policy, approvals, webhooks, and custodial signing. Most commands in this action -- `list-wallets`, `get-wallet`, `create-wallet`, `delete-wallet`, `list-addresses`, `get-balance`, `list-policies`, `set-policy-rule`, `add-webhook`, `create-webhook`, `delete-webhook`, `remove-webhook`, `list-webhooks`, `list-pending-approvals`, `approve-pending`, `reject-pending`, `wait-for-approval`, and all transaction/transfer query commands -- hit the Platform API directly.

**BitGo Express** is a self-hosted Node.js service that bundles `@bitgo/sdk-core` and performs local cryptographic signing before forwarding transactions to the platform. The legacy `sendcoins`, `sendmany`, and other signing endpoints live here. Calling them on the Platform API returns _"You have called a BitGo Express endpoint but this is the BitGo server."_

This action does **not** require or use BitGo Express. Custodial wallets sign server-side (BitGo holds the keys), so the send flow works entirely over the Platform API:

- **TSS custodial sends** route through `POST /wallet/{walletId}/txrequests` (no coin prefix) on the Platform API.
- **Multi-sig (onchain) custodial sends** route through `POST /{coin}/wallet/{walletId}/tx/initiate` on the Platform API.
- **Address creation** (`create-address`) also hits the Platform API at `POST /{coin}/wallet/{walletId}/address`.

If you need to drive hot or self-managed wallets that require local signing, use BitGo Express as a sidecar or the `@bitgo/sdk-core` SDK directly -- this action will reject non-custodial wallets with `UNSUPPORTED_WALLET_TYPE`.

---

## Error debugging

The action wraps BitGo's API errors into typed `BitGoError` instances with stable codes (see Errors above). The full BitGo response body — including `name`, `requestId`, and any context fields — is captured in `error.details`.

For local development, set `BITGO_DEBUG=1` and the action will print the full error details to stderr:

```bash
BITGO_DEBUG=1 ./scripts/run-local.sh send-transaction \
  --coin hteth --wallet-id ... --address ... --amount ...
```

In CI runs, the same details flow into `core.debug()` output (visible when debug logging is enabled).

---

## Local testing

`scripts/run-local.sh` is a thin wrapper that runs the built `dist/index.js` with `INPUT_*` environment variables set from CLI args. It's useful for exploring the BitGo API surface without setting up a full workflow.

```bash
export BITGO_ACCESS_TOKEN=v2x_test_...
export BITGO_API_URL=https://app.bitgo-test.com/api/v2

./scripts/run-local.sh list-wallets --coin hteth
./scripts/run-local.sh get-wallet --coin hteth --wallet-id <id>
./scripts/run-local.sh get-balance --coin hteth --wallet-id <id>
```

The action also has a live integration test suite at `test/live.test.js` that hits the real BitGo test API and validates every read endpoint plus an end-to-end self-send. Run with:

```bash
BITGO_LIVE_TEST=1 \
BITGO_ACCESS_TOKEN=... \
BITGO_API_URL=https://app.bitgo-test.com/api/v2 \
BITGO_TEST_COIN=hteth \
BITGO_TEST_WALLET_ID=... \
BITGO_TEST_OTP=000000 \
npm run test:live
```

---

## Cookbook recipes

- [BitGo Payroll with Native TOTP](https://github.com/w3-io/w3-mcp/blob/main/content/cookbook/bitgo-payroll-totp.md) — monthly payroll workflow combining the `crypto:` syscall for TOTP with the BitGo action for sends and approval polling.
