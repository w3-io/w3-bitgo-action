# W3 BitGo Action

BitGo institutional custody for W3 workflows. Custodial wallet management, sends with auto-detected TSS or multi-sig dispatch, **batch sends**, **token transfers** (ERC-20, etc.), policy-engine approval workflows, transfers, and webhooks. 27 commands across the full BitGo coin catalog.

## Quick start

The recommended pattern uses the W3 protocol's native `crypto:` syscall to compute the unlock OTP, so the TOTP secret never crosses the third-party action boundary:

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

- uses: w3-io/w3-bitgo-action@v0
  id: send
  with:
    command: send-transaction
    access-token: ${{ secrets.BITGO_ACCESS_TOKEN }}
    coin: hteth
    wallet-id: ${{ secrets.BITGO_WALLET_ID }}
    # Single recipient (shortcut)
    address: '0x...'
    amount: '1000000000000000'
    # — OR — batch send (mutually exclusive with address/amount)
    # recipients: |
    #   [
    #     {"address": "0xAlice", "amount": "5000000000000000000"},
    #     {"address": "0xBob",   "amount": "3000000000000000000"}
    #   ]
    # For ERC-20 / token sends, use the BitGo token coin code:
    #   coin: hteth:tusdc

- uses: w3-io/w3-bitgo-action@v0
  with:
    command: wait-for-approval
    access-token: ${{ secrets.BITGO_ACCESS_TOKEN }}
    pending-approval-id: ${{ fromJSON(steps.send.outputs.result).pendingApprovalId }}
    timeout: '300'
```

See [`docs/guide.md`](docs/guide.md) for the full per-command reference and the [BitGo Payroll cookbook recipe](https://github.com/w3-io/w3-mcp/blob/main/content/cookbook/bitgo-payroll-totp.md) for a complete monthly-payroll workflow.

## Commands

| Group                          | Commands                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session**                    | `unlock`                                                                                                                                                               |
| **Wallets**                    | `list-wallets`, `get-wallet`, `create-wallet`, `share-wallet`, `freeze-wallet`, `get-balance`, `list-addresses`, `create-address`, `maximum-spendable`, `fee-estimate` |
| **Sends and tx queries**       | `send-transaction`, `get-transaction`, `list-transactions`, `get-transfer`, `list-transfers`                                                                           |
| **TSS tx requests**            | `get-tx-request`, `list-tx-requests`                                                                                                                                   |
| **Policy and approval**        | `list-policies`, `set-policy-rule`, `remove-policy-rule`, `list-pending-approvals`, `get-pending-approval`, `approve-pending`, `reject-pending`                        |
| **Synchronous wait (Layer 2)** | `wait-for-approval`                                                                                                                                                    |
| **Webhooks (Layer 3)**         | `add-webhook`, `list-webhooks`, `remove-webhook`                                                                                                                       |

Set `register-webhook-on-pending: true` and supply `webhook-url` on `send-transaction` to auto-register a webhook against the wallet for Layer 3 async continuation.

## Custodial wallets only (v0)

This action drives the BitGo platform REST API. It supports **custodial wallets** of both signing models — TSS (MPC) and on-chain multi-sig — because BitGo holds the keys and signs server-side. It does **not** support self-managed (hot/cold) wallets, which require BitGo Express running as a sidecar or `@bitgo/sdk-core` bundled in-process. Hot wallets fail fast with `UNSUPPORTED_WALLET_TYPE` rather than producing confusing API errors.

This was a deliberate scoping decision validated against the live BitGo platform API. See [`docs/future-native-syscall.md`](docs/future-native-syscall.md) for the long-term direction (BitGo as a native protocol syscall) and the trade-offs involved.

## Inputs

| Input           | Required          | Notes                                                                                                         |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `command`       | yes               | One of the commands above.                                                                                    |
| `access-token`  | yes               | BitGo access token. Sent as `Authorization: Bearer ...`.                                                      |
| `enterprise-id` | sometimes         | Required for create/list operations scoped to an enterprise.                                                  |
| `api-url`       | no                | Defaults to `https://app.bitgo.com/api/v2`. Use `https://app.bitgo-test.com/api/v2` for the test environment. |
| `otp`           | for sensitive ops | Six-digit TOTP code from `crypto: totp` (or directly). Required by `unlock` and some approvals.               |

Command-specific inputs (`coin`, `wallet-id`, `address`, `amount`, `tx-id`, `body`, `pending-approval-id`, `correlation-id`, `webhook-url`, etc.) are documented in [`docs/guide.md`](docs/guide.md).

## Outputs

A single `result` output, always a JSON string. Parse with `fromJSON()`:

```yaml
- run: |
    echo "approval id = ${{ fromJSON(steps.send.outputs.result).pendingApprovalId }}"
    echo "correlation = ${{ fromJSON(steps.send.outputs.result).correlationId }}"
```

The send result shape:

```jsonc
{
  "status": "pending-approval",
  "pendingApprovalId": "69da0b69be4ef029a9af54692439ee00",
  "txRequestId": null, // populated on TSS path instead
  "correlationId": "...",
  "raw": {
    /* full BitGo response */
  },
}
```

## Authentication

1. **Access token** — issue from BitGo dashboard → Settings → Developer Options → Access Tokens. Store as `BITGO_ACCESS_TOKEN` secret. Test-environment tokens come from `app.bitgo-test.com` and don't work against production.
2. **TOTP secret** — BitGo's authenticator setup gives you a base32 string. Convert it to hex once (`echo -n 'JBSWY3DPEHPK3PXP' | base32 -d | xxd -p -c 256`) and store as `BITGO_TOTP_HEX`. The native `crypto: totp` syscall expects hex.
3. **Enterprise ID** — visible in the BitGo dashboard URL. Required for any operation scoped to an enterprise.

## Status

**v0.1.0 — production-credible for custodial treasury automation.** All 27 commands validated against the live BitGo test API via `test/live.test.js`, including end-to-end self-send through unlock → tx/initiate → pending approval → wait-for-approval. Mocked unit tests cover the request shape; live tests cover endpoint existence (mocks alone can't catch fictional URLs, which we learned the hard way).

The single biggest known limitation is the production OTP plumbing — the `crypto: totp` + `bitgo: unlock` chain works today on W3 nodes, but workflow authors need to convert their BitGo authenticator's base32 secret to hex when storing it.

## Local development

`scripts/run-local.sh` runs the built `dist/index.js` with `INPUT_*` env vars set from CLI args:

```bash
export BITGO_ACCESS_TOKEN=v2x_test_...
export BITGO_API_URL=https://app.bitgo-test.com/api/v2

./scripts/run-local.sh list-wallets --coin hteth
./scripts/run-local.sh get-balance --coin hteth --wallet-id <id>
```

For full live integration tests against the real BitGo test API:

```bash
BITGO_LIVE_TEST=1 \
BITGO_ACCESS_TOKEN=... \
BITGO_API_URL=https://app.bitgo-test.com/api/v2 \
BITGO_TEST_COIN=hteth \
BITGO_TEST_WALLET_ID=... \
BITGO_TEST_OTP=000000 \
npm run test:live
```

Set `BITGO_DEBUG=1` to see full BitGo error response bodies in stderr.

## License

GPL-3.0
