# E2E Test Results

> Last verified: 2026-04-15

## Prerequisites

| Credential                    | Env var              | Source             |
| ----------------------------- | -------------------- | ------------------ |
| BitGo access token (test env) | `BITGO_ACCESS_TOKEN` | app.bitgo-test.com |

## Results

| #   | Step                          | Command                  | Status | Notes                  |
| --- | ----------------------------- | ------------------------ | ------ | ---------------------- |
| 1   | Unlock session                | `unlock`                 | PASS   | OTP: 000000 (test env) |
| 2   | List wallets                  | `list-wallets`           | PASS   | coin: hteth            |
| 3   | Extract wallet ID             | (run step)               | PASS   | jq extraction          |
| 4   | Get a wallet                  | `get-wallet`             | PASS   |                        |
| 5   | Get wallet balance            | `get-balance`            | PASS   |                        |
| 6   | Get maximum spendable         | `maximum-spendable`      | PASS   |                        |
| 7   | Get fee estimate              | `fee-estimate`           | PASS   |                        |
| 8   | List addresses                | `list-addresses`         | PASS   |                        |
| 9   | Create a new address          | `create-address`         | PASS   |                        |
| 10  | List transactions             | `list-transactions`      | PASS   |                        |
| 11  | List transfers                | `list-transfers`         | PASS   |                        |
| 12  | List TSS transaction requests | `list-tx-requests`       | PASS   |                        |
| 13  | List wallet policies          | `list-policies`          | PASS   |                        |
| 14  | List pending approvals        | `list-pending-approvals` | PASS   |                        |
| 15  | List webhooks                 | `list-webhooks`          | PASS   |                        |

## Skipped Commands

| Command | Reason                                        |
| ------- | --------------------------------------------- |
| `send`  | Requires funded wallet; would move real funds |

## How to run

```bash
# Export credentials
export BITGO_ACCESS_TOKEN="..."

# Run
w3 workflow test --execute test/workflows/e2e.yaml
```
