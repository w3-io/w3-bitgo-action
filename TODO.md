# TODO

## Funded-wallet blocked

- [ ] `send` — requires a funded BitGo test wallet. Would move real
      (testnet) funds. Unblock with a Sepolia-funded BitGo wallet and
      exercise end-to-end: send → list-transactions shows the new
      outbound → list-transfers reflects it.

## API surface — not yet exposed

- [x] `create-wallet` / `delete-wallet` — lifecycle commands behind
      BitGo's `/api/v2/{coin}/wallet/generate` endpoint. `create-wallet`
      shipped earlier; `delete-wallet` added in this pass.
- [ ] TSS (multi-sig) commands: `create-tx-request`,
      `approve-tx-request`, `reject-tx-request`. Our action currently
      only lists TSS requests; writing them requires the second
      signer's keypair which is out-of-band.
- [x] Webhooks: `create-webhook` / `delete-webhook`. List already
      works; CRUD surface is now complete.

## Docs

- [x] Document the BitGo Express vs Platform API dispatch pattern in
      `docs/guide.md`.
