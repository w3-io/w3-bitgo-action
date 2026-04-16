import * as core from '@actions/core'
import { createCommandRouter, setJsonOutput, handleError, parseJsonInput } from '@w3-io/action-core'
import { BitGoClient, BitGoError } from './bitgo.js'

/**
 * W3 BitGo Action — command dispatch.
 *
 * Custodial-wallet-only signing. Each handler reads inputs via
 * @actions/core, calls a method on BitGoClient, and writes the
 * result to the `result` output as JSON.
 *
 * The send commands return a pending-approval result by default;
 * use wait-for-approval to block until terminal state, or set
 * register-webhook-on-pending=true with webhook-url to fire a
 * follow-up workflow on resolution.
 */

function getClient() {
  return new BitGoClient({
    accessToken: core.getInput('access-token', { required: true }),
    enterpriseId: core.getInput('enterprise-id') || undefined,
    apiUrl: core.getInput('api-url') || undefined,
  })
}

const handlers = {
  // ── Session ───────────────────────────────────────────────────

  unlock: async () => {
    const client = getClient()
    const result = await client.unlock({
      otp: core.getInput('otp', { required: true }),
      duration: Number(core.getInput('duration')) || undefined,
    })
    setJsonOutput('result', result)
  },

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

  'delete-wallet': async () => {
    const client = getClient()
    const result = await client.deleteWallet(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  'freeze-wallet': async () => {
    const client = getClient()
    const result = await client.freezeWallet(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      parseJsonInput('body') || {},
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

  'create-address': async () => {
    const client = getClient()
    const result = await client.createAddress(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        label: core.getInput('label') || undefined,
        chain: core.getInput('chain') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  'maximum-spendable': async () => {
    const client = getClient()
    const result = await client.maximumSpendable(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        feeRate: core.getInput('fee-rate') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  'fee-estimate': async () => {
    const client = getClient()
    const result = await client.feeEstimate(core.getInput('coin', { required: true }))
    setJsonOutput('result', result)
  },

  // ── Tier 2: Sends and tx queries ──────────────────────────────

  'send-transaction': async () => {
    const client = getClient()
    // Either `recipients` (JSON array, batch) or `address`+`amount`
    // (single-recipient shortcut) must be provided. Validation lives
    // in normalizeRecipients() inside the client.
    const result = await client.send(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        address: core.getInput('address') || undefined,
        amount: core.getInput('amount') || undefined,
        recipients: core.getInput('recipients') || undefined,
        comment: core.getInput('comment') || undefined,
        sequenceId: core.getInput('sequence-id') || undefined,
        correlationId: core.getInput('correlation-id') || undefined,
        registerWebhookOnPending: core.getInput('register-webhook-on-pending') === 'true',
        webhookUrl: core.getInput('webhook-url') || undefined,
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

  'get-transfer': async () => {
    const client = getClient()
    const result = await client.getTransfer(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      core.getInput('transfer-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  'list-transfers': async () => {
    const client = getClient()
    const result = await client.listTransfers(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        limit: core.getInput('limit') || undefined,
        prevId: core.getInput('prev-id') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  // ── TSS-specific tx requests ──────────────────────────────────

  'get-tx-request': async () => {
    const client = getClient()
    const result = await client.getTxRequest(
      core.getInput('wallet-id', { required: true }),
      core.getInput('tx-request-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  'list-tx-requests': async () => {
    const client = getClient()
    const result = await client.listTxRequests(core.getInput('wallet-id', { required: true }))
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

  'get-pending-approval': async () => {
    const client = getClient()
    const result = await client.getPendingApproval(
      core.getInput('pending-approval-id', { required: true }),
    )
    setJsonOutput('result', result)
  },

  'approve-pending': async () => {
    const client = getClient()
    const result = await client.approvePending(
      core.getInput('pending-approval-id', { required: true }),
      {
        otp: core.getInput('otp') || undefined,
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

  'create-webhook': async () => {
    const client = getClient()
    const result = await client.createWebhook(
      core.getInput('coin', { required: true }),
      core.getInput('wallet-id', { required: true }),
      {
        url: core.getInput('webhook-url', { required: true }),
        type: core.getInput('webhook-type') || undefined,
      },
    )
    setJsonOutput('result', result)
  },

  'delete-webhook': async () => {
    const client = getClient()
    const result = await client.deleteWebhook(
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
      // Surface the API response body so callers can debug. Gated
      // to debug for CI runs and BITGO_DEBUG=1 for local dev.
      if (error.details) {
        core.debug(`BitGo error details: ${JSON.stringify(error.details)}`)
        if (process.env.BITGO_DEBUG === '1') {
          process.stderr.write(`BitGo error details: ${JSON.stringify(error.details, null, 2)}\n`)
        }
      }
    } else {
      handleError(error)
    }
  }
}
