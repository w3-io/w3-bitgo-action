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

  // ── Tier 2: Transactions and signing ──────────────────────────

  'build-transaction': async () => {
    const client = getClient()
    const result = await client.buildTransaction(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        address: core.getInput('address', { required: true }),
        amount: core.getInput('amount', { required: true }),
        feeRate: core.getInput('fee-rate') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  'send-transaction': async () => {
    const client = getClient()
    const result = await client.sendTransaction(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        address: core.getInput('address', { required: true }),
        amount: core.getInput('amount', { required: true }),
        walletPassphrase: core.getInput('wallet-passphrase', { required: true }),
        feeRate: core.getInput('fee-rate') || undefined,
        comment: core.getInput('comment') || undefined,
        correlationId: core.getInput('correlation-id') || undefined,
        registerWebhookOnPending: core.getInput('register-webhook-on-pending') === 'true',
        webhookUrl: core.getInput('webhook-url') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  'send-many': async () => {
    const client = getClient()
    const body = parseJsonInput('body')
    const result = await client.sendMany(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        walletPassphrase: core.getInput('wallet-passphrase', { required: true }),
        body,
        correlationId: core.getInput('correlation-id') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  'accelerate-transaction': async () => {
    const client = getClient()
    const result = await client.accelerateTransaction(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      core.getInput('tx-id', { required: true }),
      {
        walletPassphrase: core.getInput('wallet-passphrase', { required: true }),
        feeRate: core.getInput('fee-rate') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  'get-transaction': async () => {
    const client = getClient()
    const result = await client.getTransaction(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      core.getInput('tx-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  'list-transactions': async () => {
    const client = getClient()
    const result = await client.listTransactions(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        limit: core.getInput('limit') || undefined,
        prevId: core.getInput('prev-id') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  consolidate: async () => {
    const client = getClient()
    const body = core.getInput('body') ? parseJsonInput('body') : undefined
    const result = await client.consolidate(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        walletPassphrase: core.getInput('wallet-passphrase', { required: true }),
        body,
      },
    )
    setJsonOutput('result', result)
  },

  sweep: async () => {
    const client = getClient()
    const result = await client.sweep(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        address: core.getInput('address', { required: true }),
        walletPassphrase: core.getInput('wallet-passphrase', { required: true }),
      },
    )
    setJsonOutput('result', result)
  },

  // ── Tier 3: Policy and approval ───────────────────────────────

  'list-policies': async () => {
    const client = getClient()
    const result = await client.listPolicies(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  'set-policy-rule': async () => {
    const client = getClient()
    const body = parseJsonInput('body')
    const result = await client.setPolicyRule(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      body,
    )
    setJsonOutput('result', result)
  },

  'remove-policy-rule': async () => {
    const client = getClient()
    const result = await client.removePolicyRule(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      core.getInput('policy-rule-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  'list-pending-approvals': async () => {
    const client = getClient()
    const result = await client.listPendingApprovals({
      walletId: core.getInput('wallet-id') || undefined,
      enterpriseId: core.getInput('enterprise-id') || undefined,
    })
    setJsonOutput('result', result)
  },

  'approve-pending': async () => {
    const client = getClient()
    const result = await client.approvePending(
      core.getInput('pending-approval-id', { required: true }),
      {
        walletPassphrase: core.getInput('wallet-passphrase') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  'reject-pending': async () => {
    const client = getClient()
    const result = await client.rejectPending(
      core.getInput('pending-approval-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  // ── Layer 2: Synchronous wait-for-approval ────────────────────

  'wait-for-approval': async () => {
    const client = getClient()
    const result = await client.waitForApproval(
      core.getInput('pending-approval-id', { required: true }),
      {
        timeout: Number(core.getInput('timeout')) || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  // ── Tier 4: Webhook registration ──────────────────────────────

  'add-webhook': async () => {
    const client = getClient()
    const result = await client.addWebhook(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        url: core.getInput('webhook-url', { required: true }),
        type: core.getInput('webhook-type') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  'list-webhooks': async () => {
    const client = getClient()
    const result = await client.listWebhooks(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  'remove-webhook': async () => {
    const client = getClient()
    const result = await client.removeWebhook(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      core.getInput('webhook-id', { required: true }),
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
