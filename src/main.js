import * as core from '@actions/core'
import { createCommandRouter, setJsonOutput, handleError, parseJsonInput } from '@w3-io/action-core'
import { BitGoClient, BitGoError } from './bitgo.js'

/**
 * W3 BitGo Action — command dispatch.
 *
 * Each command handler is an async function that:
 *   1. Reads inputs via @actions/core
 *   2. Calls a method on BitGoClient
 *   3. Sets the JSON output via setJsonOutput
 *
 * The createCommandRouter from @w3-io/action-core handles dispatch
 * by command name and reports unknown commands with the available list.
 *
 * Tier 2 (transactions/signing), Tier 3 (policy/approval), Layer 2
 * (wait-for-approval), and Tier 4 (webhooks) land in subsequent commits.
 */

function getClient() {
  return new BitGoClient({
    accessToken: core.getInput('access-token', { required: true }),
    enterpriseId: core.getInput('enterprise-id') || undefined,
    walletPassphrase: core.getInput('wallet-passphrase') || undefined,
    apiUrl: core.getInput('api-url') || undefined,
  })
}

const handlers = {
  // ── Tier 1: Wallet management ─────────────────────────────────

  'list-wallets': async () => {
    const client = getClient()
    const result = await client.listWallets(core.getInput('coin', { required: true }), {
      enterpriseId: core.getInput('enterprise-id') || undefined,
      limit: core.getInput('limit') || undefined,
      prevId: core.getInput('prev-id') || undefined,
    })
    setJsonOutput('result', result)
  },

  'get-wallet': async () => {
    const client = getClient()
    const result = await client.getWallet(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  'create-wallet': async () => {
    const client = getClient()
    const body = parseJsonInput('body')
    const result = await client.createWallet(core.getInput('coin', { required: true }), body, {
      enterpriseId: core.getInput('enterprise-id') || undefined,
    })
    setJsonOutput('result', result)
  },

  'share-wallet': async () => {
    const client = getClient()
    const result = await client.shareWallet(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        user: core.getInput('share-with-user', { required: true }),
        permissions: core.getInput('share-permissions', { required: true }),
      },
    )
    setJsonOutput('result', result)
  },

  'freeze-wallet': async () => {
    const client = getClient()
    const body = core.getInput('body') ? parseJsonInput('body') : {}
    const result = await client.freezeWallet(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      body,
    )
    setJsonOutput('result', result)
  },

  'get-balance': async () => {
    const client = getClient()
    const result = await client.getBalance(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  'list-addresses': async () => {
    const client = getClient()
    const result = await client.listAddresses(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        limit: core.getInput('limit') || undefined,
        prevId: core.getInput('prev-id') || undefined,
      },
    )
    setJsonOutput('result', result)
  },
}

const router = createCommandRouter(handlers)

export async function run() {
  try {
    await router()
  } catch (error) {
    if (error instanceof BitGoError) {
      core.setFailed(`BitGo error (${error.code}): ${error.message}`)
    } else {
      handleError(error)
    }
  }
}
