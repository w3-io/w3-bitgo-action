# W3 Action Template

Start here to build a new action for W3 workflows.

Actions built from this template work on both the W3 runtime and GitHub
Actions runners — same YAML, both environments.

## Getting started

1. **Create your repo** from this template:

   ```bash
   gh repo create w3-io/w3-yourpartner-action \
     --public \
     --template w3-io/w3-action-template \
     --clone
   cd w3-yourpartner-action
   ```

2. **Set up GitHub Packages auth** (one-time, for `@w3-io/action-core`):

   ```bash
   echo "//npm.pkg.github.com/:_authToken=$(gh auth token)" >> ~/.npmrc
   echo "@w3-io:registry=https://npm.pkg.github.com" >> ~/.npmrc
   ```

3. **Install dependencies:**

   ```bash
   npm install
   ```

4. **Rename the placeholders.** Search for `TODO` across the codebase.
   Main things to change:

   - `action.yml` — your action's name, description, inputs, commands
   - `src/index.js` — wire your commands into the router
   - `src/client.js` — your API client (the core logic)
   - `w3-action.yaml` — registry metadata for MCP discovery
   - `README.md` — replace this with your action's docs

5. **Write your client** in `src/client.js`. Keep it independent of
   `@actions/core` so it can be imported directly by others.

6. **Add commands** to `src/index.js`. Use the `createCommandRouter`
   from `@w3-io/action-core`:

   ```javascript
   import { createCommandRouter, setJsonOutput, handleError } from '@w3-io/action-core'
   import * as core from '@actions/core'
   import { Client } from './client.js'

   const router = createCommandRouter({
     'my-command': async () => {
       const client = new Client({ apiKey: core.getInput('api-key') })
       const result = await client.myCommand(core.getInput('input'))
       setJsonOutput('result', result)
     },
   })

   router()
   ```

7. **Write tests** in `test/`. Use `node:test` and `node:assert`:

   ```bash
   npm test
   ```

8. **Build and verify:**

   ```bash
   npm run build     # bundle to dist/ with NCC
   npm run all       # format + lint + test + build
   ```

9. **Commit dist/ and tag** a release:

   ```bash
   git add dist/ && git commit -m "Build dist"
   git tag v0.1.0 && git tag v0
   git push --tags
   ```

   Users reference your action as:

   ```yaml
   uses: w3-io/w3-yourpartner-action@v0
   ```

## What `@w3-io/action-core` gives you

Every W3 action uses the shared library. Don't reinvent these:

| Import | What it does |
|--------|-------------|
| `createCommandRouter` | Dispatches on the `command` input, handles unknown commands |
| `setJsonOutput` | Serializes output exactly once (prevents double-encoding) |
| `handleError` | Structured error reporting with codes and status |
| `request` | HTTP with timeout, retry on 429/5xx, auth helpers |
| `requireInput` | Throws with clear message if input is missing |
| `parseJsonInput` | Parses JSON input with error handling |
| `bridge` | Syscall bridge client for chain/crypto operations |

### Using the bridge

If your action needs blockchain or crypto operations, use the bridge
instead of bundling SDKs:

```javascript
import { bridge } from '@w3-io/action-core'

// Chain operations (ethereum, bitcoin, solana)
const balance = await bridge.chain('ethereum', 'get-balance', { address })

// Crypto primitives
const hash = await bridge.crypto('keccak256', { data: '0xdeadbeef' })
```

The bridge runs on the host — no `ethers`, `web3.js`, or WASM in your container.

## Conventions

### Inputs

| Input | Convention |
|-------|-----------|
| `command` | Required. The operation to perform. |
| `api-key` | API key. Always `api-key`, never `apikey` or `api_key`. |
| `api-url` | Optional endpoint override for staging/testing. |
| (others) | Plain names, no partner prefix. `address`, not `cube3-address`. |

### Outputs

One output: `result`. Always JSON. Use `setJsonOutput('result', data)`.

### Errors

Use `handleError` from action-core. It sets structured error codes
and calls `core.setFailed()`.

### File structure

```
w3-yourpartner-action/
├── README.md               # Quick Start, Commands, Inputs, Outputs, Auth
├── action.yml              # GHA contract — inputs, outputs, runtime
├── w3-action.yaml          # MCP registry metadata
├── src/
│   ├── index.js            # Command router (uses action-core)
│   └── client.js           # Your API client
├── test/
│   └── client.test.js      # Tests (node:test)
├── docs/
│   └── guide.md            # Integration guide (synced to MCP)
├── dist/
│   └── index.js            # Bundled by NCC (committed)
├── package.json            # NCC build, action-core dep
└── .gitignore              # Includes .npmrc, excludes dist/
```

### README structure

Every action README follows this format:

```markdown
# W3 YourPartner Action
One-line description.

## Quick Start
## Commands (table: command, description)
## Inputs (table: name, required, default, description)
## Outputs (table: name, description)
## Authentication
```

## MCP integration

When your action is released, add it to the W3 MCP registry so the
explorer chat and Claude Code can discover it:

1. Add your action to `w3-mcp/registry.yaml` under `gha-actions:`
2. Include all commands with typed input/output schemas
3. Add a guide to `w3-mcp/content/integrations/`
4. Run `w3-mcp/scripts/sync-registry.sh` to verify

## Examples

Actions built from this template:

- [w3-chainalysis-action](https://github.com/w3-io/w3-chainalysis-action) — Sanctions screening (single command)
- [w3-pyth-action](https://github.com/w3-io/w3-pyth-action) — Price oracle (3 commands, no auth)
- [w3-stripe-action](https://github.com/w3-io/w3-stripe-action) — Payments (41 commands)
- [w3-email-action](https://github.com/w3-io/w3-email-action) — Multi-provider email
