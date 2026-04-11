# W3 BitGo Action

BitGo institutional custody and signing for W3 workflows. Wallet
management, transactions with auto-detected TSS or multi-sig signing,
policy approval workflows, and webhook registration — across the full
BitGo coin catalog.

## Quick Start

```yaml
- uses: w3-io/w3-bitgo-action@v0
  id: balance
  with:
    command: get-balance
    access-token: ${{ secrets.BITGO_ACCESS_TOKEN }}
    coin: btc
    wallet-id: ${{ secrets.BITGO_WALLET_ID }}

- uses: w3-io/w3-bitgo-action@v0
  with:
    command: send-transaction
    access-token: ${{ secrets.BITGO_ACCESS_TOKEN }}
    wallet-passphrase: ${{ secrets.BITGO_WALLET_PASSPHRASE }}
    coin: btc
    wallet-id: ${{ secrets.BITGO_WALLET_ID }}
    address: bc1q...
    amount: '50000'
```

## Commands

| Group                 | Commands                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wallets**           | `list-wallets`, `get-wallet`, `create-wallet`, `share-wallet`, `freeze-wallet`, `get-balance`, `list-addresses`                                |
| **Transactions**      | `build-transaction`, `send-transaction`, `send-many`, `accelerate-transaction`, `get-transaction`, `list-transactions`, `consolidate`, `sweep` |
| **Policy & approval** | `list-policies`, `set-policy-rule`, `remove-policy-rule`, `list-pending-approvals`, `approve-pending`, `reject-pending`, `wait-for-approval`   |
| **Webhooks**          | `add-webhook`, `list-webhooks`, `remove-webhook`                                                                                               |

See [`docs/guide.md`](docs/guide.md) for the full reference, every
command's inputs and outputs, the TSS-vs-multi-sig auto-detection
story, and the three-layer approval reactivity model.

## Inputs

| Input               | Required                | Notes                                                                                                               |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `command`           | yes                     | One of the commands above.                                                                                          |
| `access-token`      | yes                     | BitGo access token. Sent as `Authorization: Bearer ...`.                                                            |
| `enterprise-id`     | for create/list scoping | Defaults inherited by `list-wallets` and `create-wallet`.                                                           |
| `wallet-passphrase` | for signing commands    | Decrypts the user keychain. Never logged.                                                                           |
| `api-url`           | no                      | Defaults to `https://app.bitgo.com/api/v2`. Use `https://app.bitgo-test.com/api/v2` for the BitGo test environment. |

Command-specific inputs (`coin`, `wallet-id`, `address`, `amount`,
`tx-id`, `body`, `pending-approval-id`, `correlation-id`,
`webhook-url`, etc.) are listed in `docs/guide.md`.

## Outputs

A single `result` output, always a JSON string. Document the schema
per command in `docs/guide.md`. Example:

```yaml
- uses: w3-io/w3-bitgo-action@v0
  id: send
  with:
    command: send-transaction
    # ...

- run: echo "tx hash = ${{ fromJSON(steps.send.outputs.result).txHash }}"
```

## Authentication

1. **Access token**: create an access token in the BitGo dashboard
   (Settings → Developer Options → Access Tokens). Store as
   `BITGO_ACCESS_TOKEN` secret in your repo.
2. **Wallet passphrase**: only needed for signing operations. Store
   as `BITGO_WALLET_PASSPHRASE` secret. The action never logs it.
3. **Enterprise ID**: visible in the BitGo dashboard URL. Required
   for any operation scoped to an enterprise (create, list).

For test-environment work, set `api-url` to
`https://app.bitgo-test.com/api/v2` and use a token issued from
`app.bitgo-test.com`.

## Status

Pre-release (v0.1.0). Tier 1 (wallet management) ships in this
bootstrap commit; tiers 2–4 land in subsequent commits before the
v0 tag. The action targets both the BitGo test environment and
production.

## License

GPL-3.0
