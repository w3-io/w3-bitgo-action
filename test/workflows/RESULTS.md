# E2E Test Results

Last verified: 2026-04-15

## Environment

- W3 local network (3-node localnet)
- Protocol: master (includes EIP-712, bridge-allow expansion, nonce manager)
- Runner image: w3io/w3-runner (Node 20/24)

## Prerequisites

- W3 local network running (make dev)
- W3_SECRET_BITGO_ACCESS_TOKEN set to a BitGo test environment access token
- Uses BitGo test environment (app.bitgo-test.com) by default

## Results

| Step | Command | Status | Notes |
|------|---------|--------|-------|
| 1 | unlock | PASS | Session unlock with OTP |
| 2 | list-wallets | PASS | hteth, limit 5 |
| 3 | extract wallet ID | PASS | Helper step (jq parse) |
| 4 | get-wallet | PASS | By wallet ID |
| 5 | get-balance | PASS | Wallet balance |
| 6 | maximum-spendable | PASS | Max spendable amount |
| 7 | fee-estimate | PASS | hteth fee estimate |
| 8 | list-addresses | PASS | Wallet addresses, limit 5 |
| 9 | create-address | PASS | New address with label |
| 10 | list-transactions | PASS | Wallet transactions, limit 5 |
| 11 | list-transfers | PASS | Wallet transfers, limit 5 |
| 12 | list-tx-requests | PASS | TSS transaction requests |
| 13 | list-policies | PASS | Wallet policies |
| 14 | list-pending-approvals | PASS | Pending approvals |
| 15 | list-webhooks | PASS | Wallet webhooks |

## Known Limitations

- None. All commands tested against BitGo test environment.
