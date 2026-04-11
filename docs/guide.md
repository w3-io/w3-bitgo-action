# BitGo Integration

## What is BitGo?

[BitGo](https://www.bitgo.com) is a regulated qualified custodian and
signing platform for institutional crypto. It offers:

- **Hot wallets** with multi-sig (3-of-3) or TSS (MPC) signing
- **Cold storage** with regulated custody
- **Policy engine** for spending limits, velocity, allowlists, and
  multi-party approval
- **Coverage** for ~700 coins and tokens, including the long tail of
  chains other custodians don't support
- **WaaS** (wallet-as-a-service) APIs for issuing wallets to end users

Use BitGo when a workflow needs regulated custody, advanced policy
approval workflows, or signing on the long-tail of coins. ForDefi is
a closer fit for pure MPC; Privy is a closer fit for embedded
consumer wallets; Circle is a closer fit for USDC-centric flows. BitGo
is the answer for everything else, especially anything that needs
qualified-custody compliance.

## Status

This guide is a stub for the v0.1.0 bootstrap. Tier 1 (wallet
management) is implemented; tiers 2–4 (transactions, policy,
webhooks) and the full reference land in subsequent commits before
the v0 tag.

## Tier 1 — Wallet management (implemented)

| Command          | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `list-wallets`   | List wallets in the enterprise                                      |
| `get-wallet`     | Get wallet details                                                  |
| `create-wallet`  | Create a new wallet (use `body` input for the full creation config) |
| `share-wallet`   | Share a wallet with another BitGo user                              |
| `freeze-wallet`  | Time-bound freeze on a wallet                                       |
| `get-balance`    | Confirmed and spendable balance                                     |
| `list-addresses` | List addresses derived under a wallet                               |

See [`w3-action.yaml`](../w3-action.yaml) for the full input/output
schema of each command.

## Coming in subsequent commits

- **Tier 2** — Transactions and signing (8 commands) with auto-detect
  TSS vs multi-sig at runtime
- **Tier 3** — Policy and approval workflows (6 commands)
- **Layer 2** — `wait-for-approval` polling command
- **Tier 4** — Webhook registration (3 commands) plus
  `register-webhook-on-pending` flag for Layer 3 async continuation
- **Three-layer approval reactivity** model (return-and-exit,
  synchronous wait, async webhook → workflow trigger)
- Full per-command reference with example YAML
- Real workflow patterns (treasury send with policy approval, batch
  consolidate, sweep on cleanup)

## Authentication

See the README's "Authentication" section for the access token,
wallet passphrase, and enterprise ID setup. For test-environment
work, point `api-url` at `https://app.bitgo-test.com/api/v2` and
use credentials issued from `app.bitgo-test.com`.
