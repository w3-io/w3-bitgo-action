# Future: BitGo as a Native Syscall

This is a forward-looking design note, not a v0 deliverable. It documents the architectural direction we'd take to move the security-critical parts of the BitGo integration into the protocol process, parallel to how `crypto:`, `ethereum:`, `bitcoin:`, and `solana:` are exposed today.

## Why

The current `w3-bitgo-action` is a third-party Node action. The BitGo `access-token` flows as a workflow secret into the action container, which uses it to call BitGo's REST API. That works, but it crosses the third-party-action trust boundary for the most sensitive credential in the integration.

The W3 protocol already supports native syscalls for things that "don't make sense to run in Docker" — fast operations that need to keep secrets inside the protocol's secret resolver. The `crypto:` step kind is the canonical example: TOTP secrets, signing keys, and AES keys never leave the protocol process. The action layer never sees them.

A `bitgo:` step kind would extend that pattern to BitGo: the access token lives in the protocol's secret store, the workflow declares intent (`bitgo: send-transaction:` with recipient and amount), and a native syscall handler in the protocol makes the BitGo HTTP call directly. The action layer never sees the token, and we get the same Docker-free latency profile as `crypto:`.

## Shape

```yaml
# Today (v0)
- uses: w3-io/w3-bitgo-action@v0
  with:
    command: send-transaction
    access-token: ${{ secrets.BITGO_ACCESS_TOKEN }} # ← secret in action env
    coin: hteth
    wallet-id: ${{ secrets.BITGO_WALLET_ID }}
    address: 0x...
    amount: '1000000000000000'

# Proposed (future)
- bitgo:
    send-transaction:
      coin: hteth
      wallet-id: ${{ secrets.BITGO_WALLET_ID }}
      address: 0x...
      amount: '1000000000000000'
  # access-token resolved by the protocol from a named secret in
  # protocol secret store; never visible to step output or action env
```

The native form is shorter, faster (no container spawn), and keeps the access token inside the protocol's secret resolver — same security property the `crypto:` syscall already provides for keys.

## Implementation sketch

Mirror the existing `crypto:` syscall layout:

```
protocol/
├── src/lib/bitgo-core/                   # NEW: pure Rust BitGo API client
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── client.rs                     # HTTP client, auth, error mapping
│       ├── wallet.rs                     # wallet operations
│       ├── send.rs                       # tx/initiate + txrequests dispatch
│       ├── policy.rs                     # policy + approval
│       └── webhook.rs                    # webhook CRUD
│
├── src/core/workflow/dsl/src/types/step/definition/
│   └── bitgo_step.rs                     # NEW: BitGoStepBody (mirror CryptoStepBody)
│
├── src/core/workflow/syscalls/src/
│   ├── types/bitgo/                      # NEW: BitGoSyscall, BitGoInput, BitGoOutput
│   └── impls/bitgo.rs                    # NEW: dispatch + impl
│
└── src/core/workflow/bridge/src/routes/
    └── bitgo.rs                          # NEW: HTTP routes for the Docker bridge

w3-actions/
└── bitgo-native/                         # NEW: thin Node wrapper + WASM bridge
    ├── action.yml
    ├── src/index.js
    └── wasm-bridge/
        ├── Cargo.toml
        └── src/lib.rs                    # cdylib over w3io_bitgo_core
```

The same crate (`w3io_bitgo_core`) is consumed by:

1. **The protocol's syscall handler** — fastest path, no Docker, secret stays in-process
2. **The WASM bridge** in `w3-actions/bitgo-native/` — for local dev without a network and for running on actual GHA runners

The existing `w3-bitgo-action` (Node + REST) doesn't go away; it becomes the broad-surface fallback for non-sensitive operations and for users who haven't migrated to the native form. Same pattern as `crypto`, where both `uses: w3-io/w3-actions/crypto@v0` and `crypto:` continue to work — the native form is the recommended path inside W3 workflows, and the GHA-compat form remains for portability.

## What native form unlocks

Beyond the secret-handling improvement:

1. **No Docker cold start.** Native syscalls are in-process. A workflow that does N BitGo operations pays the start cost zero times instead of N times.
2. **Direct integration with the protocol's chain providers.** A `bitgo:` step could feed signed transactions directly into the EVM chain provider's broadcast path — same way `ethereum: send` works today with the Lit signer — instead of round-tripping through the action's stdout.
3. **First-class typing in the DSL.** The DSL knows `bitgo: send-transaction` is a thing, can type-check inputs at compile time, and `compile-workflow` (in the W3 MCP) can catch typos before deploy.
4. **Audit-grade structured logging.** The protocol's `log!` infrastructure produces structured events with consistent keys; the action's stdout is unstructured.

## What native form does NOT unlock

This is not the answer for everything BitGo does. Specifically, the things that currently belong in BitGo Express stay out of scope for the same reason they're out of scope for the action:

- **Self-managed (hot/cold) wallet signing** — needs `@bitgo/sdk-core`, which is too heavy to bundle in either layer
- **Token transfers** that require local SDK construction — same constraint
- **Multi-recipient batch sends** built via local SDK paths

A future native syscall would cover the same custodial-only surface as today's action, just with better security and lower latency.

## Open questions

1. **Does the W3 protocol's `bitgo:` syscall belong in the protocol repo or in a separate crate that the protocol pulls in as a dependency?** The Lit signer lives in `protocol/src/core/chain/src/lit/`. BitGo is a much larger surface — probably wants its own crate.
2. **How does the unlock + OTP flow work in the native form?** The `crypto: totp` + `bitgo: unlock` chain still works, but the unlock is per-token-per-process. If multiple workflow steps need to unlock the same token, the protocol could cache unlock state per-credential — saving HTTP roundtrips and OTP consumption.
3. **Where do BitGo webhooks land?** Today they go to a third-party HTTP endpoint and the workflow author wires up the receiver separately. A native form could expose them as protocol-level events that workflows subscribe to, parallel to chain event triggers.
4. **Migration path** for users who have the action working today. Probably the action remains for a release cycle or two, with deprecation warnings pointing at the native form once it's stable.

## When

After v0.x of the action ships, has real users, and we have signal on which BitGo operations are actually high-value enough to justify protocol-side code. Premature optimization is a real risk: it's easier to delete an action than to delete a protocol-internal Rust crate that's been in production for a year.

The trigger to start native work is one of:

- Multiple users hit the access-token-exposure limitation in production and want it solved
- Latency from Docker cold starts becomes the bottleneck for high-frequency BitGo workflows
- The same code patterns in the action keep showing up across workflows in ways that suggest "this should be a primitive"
