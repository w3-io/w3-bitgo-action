# W3 Action Development Guide

## Required: @w3-io/action-core

Every W3 action uses `@w3-io/action-core`. Do not build without it.

```bash
echo "@w3-io:registry=https://npm.pkg.github.com" >> .npmrc
npm install @w3-io/action-core
```

### What it provides (use these, don't reinvent them)

| Import | Purpose |
|--------|---------|
| `createCommandRouter` | Dispatches on the `command` input. Handles unknown commands. |
| `setJsonOutput` | Sets output, serializes exactly once. Prevents double-encoding. |
| `handleError` | Structured error with code. Use as `.catch(handleError)`. |
| `request` | HTTP with timeout, retry on 429/5xx, auth helpers. |
| `bridge` | Syscall bridge client for chain and crypto operations. |
| `requireInput` | Throws clear error if input missing. |
| `parseJsonInput` | Parses JSON input with error handling. |
| `W3ActionError` | Error class with code and statusCode. |

### Entry point pattern

```javascript
import { createCommandRouter, setJsonOutput, handleError } from '@w3-io/action-core'
import * as core from '@actions/core'

const router = createCommandRouter({
  'my-command': async () => {
    const input = core.getInput('input', { required: true })
    // ... do work ...
    setJsonOutput('result', { data: 'value' })
  },
})

router()
```

## Do NOT bundle blockchain SDKs

If your action needs chain operations (read contracts, send transactions,
get balances, transfer tokens), use the syscall bridge — NOT ethers.js,
web3.js, @solana/web3.js, or any other blockchain SDK.

```javascript
import { bridge } from '@w3-io/action-core'

// Read a contract
const result = await bridge.chain('ethereum', 'read-contract', {
  contractAddress: '0x...',
  functionSignature: 'function balanceOf(address) returns (uint256)',
  args: JSON.stringify(['0x...']),
}, 'base')

// Write to a contract (bridge handles signing)
const tx = await bridge.chain('ethereum', 'call-contract', {
  contractAddress: '0x...',
  functionSignature: 'function deposit(string poId, uint256 amount)',
  args: JSON.stringify(['PO-001', '1000000']),
}, 'base')

// Crypto operations
const hash = await bridge.crypto('keccak256', { data: '0xdeadbeef' })
```

**Why:** The bridge runs on the host. It handles signing via `W3_SECRET_*`
keys that never enter the container. Bundling ethers adds 300KB+ to your
action and requires private keys as inputs — a security risk.

**Available bridge operations:**
- Ethereum: read-contract, call-contract, send-transaction, get-balance, transfer, approve-token, transfer-token, get-token-balance, get-events, deploy-contract, and more
- Bitcoin: get-balance, send, get-utxos, get-fee-rate
- Solana: get-balance, transfer, call-program, get-token-balance
- Crypto: keccak256, aes-encrypt/decrypt, ed25519-sign/verify, hkdf, jwt-sign/verify, totp

**Bridge param names** (these must be exact):
- `contractAddress` not `contract` or `to`
- `functionSignature` not `method` or `abi`
- `args` as JSON string: `JSON.stringify(['arg1', 'arg2'])`

## Do NOT use WASM

If your action needs crypto or encoding operations, use:
- The bridge for crypto: `bridge.crypto('keccak256', ...)`
- Node built-ins for encoding: `Buffer.from()`, `node:crypto`

Do NOT create a Rust wasm-bridge directory. Do NOT use wasm-bindgen.

## Build system: NCC only

Use `@vercel/ncc`. Do NOT use Rollup.

```json
{
  "scripts": {
    "build": "ncc build src/index.js -o dist"
  },
  "devDependencies": {
    "@vercel/ncc": "^0.38.0"
  }
}
```

No `rollup.config.js`. No `@rollup/plugin-*` dependencies.

## Do NOT copy bridge code

Do NOT copy `lib/bridge.js` or any bridge SDK code into your repo.
The bridge client is in `@w3-io/action-core`. Import it:

```javascript
import { bridge } from '@w3-io/action-core'
```

## Output format

One output: `result`. Always use `setJsonOutput`:

```javascript
import { setJsonOutput } from '@w3-io/action-core'
setJsonOutput('result', { key: 'value' })
```

Do NOT use `core.setOutput('result', JSON.stringify(data))` — this
causes double-encoding when the data is already a string.

## Error handling

```javascript
import { handleError, W3ActionError } from '@w3-io/action-core'

// In your command handler, throw W3ActionError:
throw new W3ActionError('MISSING_INPUT', 'po-id is required')

// At the entry point, catch with handleError:
main().catch(handleError)
// or use createCommandRouter which handles this automatically
```

Do NOT use `core.setFailed(error.message)` directly.

## Tests

Use `node:test` and `node:assert/strict`. No Jest.

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
```

Put tests in `test/*.test.js`. Run with `node --test test/*.test.js`.

## File structure

```
w3-yourpartner-action/
├── action.yml          # main: 'dist/index.js'
├── package.json        # @w3-io/action-core + @vercel/ncc
├── src/
│   ├── index.js        # createCommandRouter entry point
│   └── client.js       # API client (uses request() from action-core)
├── test/
│   └── client.test.js  # node:test
├── dist/
│   └── index.js        # NCC output (committed)
├── README.md           # Quick Start, Commands, Inputs, Outputs, Auth
└── .gitignore          # includes .npmrc
```

## .gitignore must include .npmrc

```
node_modules/
.npmrc
```

`.npmrc` contains GitHub Packages auth tokens. Never commit it.

`dist/` must NOT be in `.gitignore` — GitHub Actions needs the built file.

## README format

Every action follows this structure:

```markdown
# W3 YourPartner Action
One-line description.

## Quick Start
## Commands (table)
## Inputs (table)
## Outputs (table)
## Authentication
```

## Two-tier documentation

Every action needs docs in two places:

### 1. `docs/guide.md` in the action repo (deep)

The complete reference. Everything a developer needs:
- What the partner/service does and why you'd use it
- Every command with inputs, outputs, and example YAML
- Authentication setup
- Error handling and common issues
- Real workflow patterns (not just API calls)

This is the source of truth. Keep it up to date when commands change.

### 2. MCP integration guide (short)

A brief orientation in `w3-mcp/content/integrations/yourpartner.md`:
- One paragraph: what it does, when to use it
- One quick-start YAML example
- Link to the full guide in the action repo

This is what the AI reads first. It should answer "should I use this?"
and point to `docs/guide.md` for "how do I use this?"

### After creating both

Register the action in `w3-mcp/registry.yaml` with all commands and
typed schemas. Run `w3-mcp/scripts/sync-registry.sh` to verify.

## w3-action.yaml

Every action repo should include a `w3-action.yaml` file with the
machine-readable command schemas. This is the source that gets merged
into the MCP registry. Keep it in sync with `action.yml`.
