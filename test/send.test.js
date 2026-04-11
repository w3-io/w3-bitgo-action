/**
 * Custodial send tests.
 *
 * Covers the two real BitGo platform-API send paths:
 *   - TSS custodial   → POST /wallet/:id/txrequests
 *   - Multi-sig (onchain) custodial → POST /:coin/wallet/:id/tx/initiate
 *
 * Both responses get translated into a uniform pending-approval
 * shape so callers don't need to know which underlying flow ran.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { BitGoClient, BitGoError } from '../src/bitgo.js'

const ACCESS_TOKEN = 'v2x_test_token'
const API_URL = 'https://app.bitgo-test.com/api/v2'

let originalFetch
let calls

beforeEach(() => {
  originalFetch = global.fetch
  calls = []
})

afterEach(() => {
  global.fetch = originalFetch
})

function mockFetch(responses) {
  let index = 0
  global.fetch = async (url, options) => {
    calls.push({ url, options })
    const response = responses[index++]
    if (!response) throw new Error(`Unexpected fetch call ${index}: ${url}`)
    const status = response.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify(response.body ?? {}),
      json: async () => response.body ?? {},
    }
  }
}

function newClient() {
  return new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })
}

// ── TSS custodial path ──────────────────────────────────────────

describe('send: TSS custodial path', () => {
  it('POSTs to /wallet/:id/txrequests with the nested intent shape', async () => {
    mockFetch([
      // detectWalletType
      { body: { id: 'w1', type: 'custodial', multisigType: 'tss' } },
      // POST /wallet/:id/txrequests
      {
        body: {
          txRequestId: 'tr-123',
          walletId: 'w1',
          walletType: 'custodial',
          state: 'pendingDelivery',
          intent: { intentType: 'payment' },
        },
      },
    ])

    const result = await newClient().send('hteth', 'w1', {
      address: '0xabc',
      amount: '1000000000000000',
    })

    // Wallet detection call
    assert.equal(calls[0].url, `${API_URL}/hteth/wallet/w1`)

    // txrequests POST — note no coin prefix
    assert.equal(calls[1].url, `${API_URL}/wallet/w1/txrequests`)
    assert.equal(calls[1].options.method, 'POST')

    const body = JSON.parse(calls[1].options.body)
    assert.equal(body.apiVersion, 'full')
    assert.equal(body.preview, false)
    assert.equal(body.intent.intentType, 'payment')
    assert.deepEqual(body.intent.recipients[0].address, { address: '0xabc' })
    assert.deepEqual(body.intent.recipients[0].amount, {
      value: '1000000000000000',
      symbol: 'hteth',
    })

    // Result is the uniform pending-approval shape with the txRequestId
    assert.equal(result.status, 'pending-approval')
    assert.equal(result.txRequestId, 'tr-123')
    assert.ok(result.correlationId)
  })

  it('embeds the correlation ID in the intent comment', async () => {
    mockFetch([
      { body: { id: 'w1', type: 'custodial', multisigType: 'tss' } },
      { body: { txRequestId: 'tr-123' } },
    ])

    const result = await newClient().send('hteth', 'w1', {
      address: '0xabc',
      amount: '1',
      comment: 'monthly payroll',
    })

    const body = JSON.parse(calls[1].options.body)
    assert.match(body.intent.comment, /^monthly payroll \[w3-corr:[0-9a-f-]+\]$/)
    assert.match(body.intent.comment, new RegExp(`\\[w3-corr:${result.correlationId}\\]`))
  })

  it('forwards a caller-supplied correlation ID', async () => {
    mockFetch([
      { body: { id: 'w1', type: 'custodial', multisigType: 'tss' } },
      { body: { txRequestId: 'tr-123' } },
    ])

    const result = await newClient().send('hteth', 'w1', {
      address: '0xabc',
      amount: '1',
      correlationId: 'workflow-7-run-42',
    })

    assert.equal(result.correlationId, 'workflow-7-run-42')
    const body = JSON.parse(calls[1].options.body)
    assert.match(body.intent.comment, /\[w3-corr:workflow-7-run-42\]/)
  })

  it('forwards an optional sequence ID', async () => {
    mockFetch([
      { body: { id: 'w1', type: 'custodial', multisigType: 'tss' } },
      { body: { txRequestId: 'tr-123' } },
    ])

    await newClient().send('hteth', 'w1', {
      address: '0xabc',
      amount: '1',
      sequenceId: 'idempotency-key-1',
    })

    const body = JSON.parse(calls[1].options.body)
    assert.equal(body.intent.sequenceId, 'idempotency-key-1')
  })
})

// ── Multi-sig custodial path ────────────────────────────────────

describe('send: multi-sig (onchain) custodial path', () => {
  it('POSTs to /:coin/wallet/:id/tx/initiate with a flat recipients array', async () => {
    mockFetch([
      { body: { id: 'w1', type: 'custodial', multisigType: 'onchain' } },
      {
        body: {
          error: 'Awaiting transaction signature',
          pendingApproval: {
            id: 'pa-456',
            wallet: 'w1',
            walletType: 'custodial',
            state: 'awaitingSignature',
          },
        },
      },
    ])

    const result = await newClient().send('hteth', 'w1', {
      address: '0xabc',
      amount: '1000000000000000',
    })

    assert.equal(calls[0].url, `${API_URL}/hteth/wallet/w1`)
    assert.equal(calls[1].url, `${API_URL}/hteth/wallet/w1/tx/initiate`)
    assert.equal(calls[1].options.method, 'POST')

    const body = JSON.parse(calls[1].options.body)
    assert.deepEqual(body.recipients, [{ address: '0xabc', amount: '1000000000000000' }])
    assert.match(body.comment, /^\[w3-corr:[0-9a-f-]+\]$/)

    // The pendingApproval is extracted into our uniform shape
    assert.equal(result.status, 'pending-approval')
    assert.equal(result.pendingApprovalId, 'pa-456')
    assert.equal(result.txRequestId, null)
  })

  it('handles BitGo flatter pendingApprovalId shape too', async () => {
    mockFetch([
      { body: { id: 'w1', type: 'custodial', multisigType: 'onchain' } },
      { body: { pendingApprovalId: 'pa-789' } },
    ])

    const result = await newClient().send('hteth', 'w1', {
      address: '0xabc',
      amount: '1',
    })

    assert.equal(result.pendingApprovalId, 'pa-789')
  })

  it('forwards an optional sequence ID at the top level', async () => {
    mockFetch([
      { body: { id: 'w1', type: 'custodial', multisigType: 'onchain' } },
      { body: { pendingApprovalId: 'pa-1' } },
    ])

    await newClient().send('hteth', 'w1', {
      address: '0xabc',
      amount: '1',
      sequenceId: 'idem-1',
    })

    const body = JSON.parse(calls[1].options.body)
    assert.equal(body.sequenceId, 'idem-1')
  })
})

// ── Wallet-type validation ──────────────────────────────────────

describe('send: wallet-type validation', () => {
  it('rejects hot wallets with UNSUPPORTED_WALLET_TYPE', async () => {
    mockFetch([{ body: { id: 'w1', type: 'hot', multisigType: 'onchain' } }])

    await assert.rejects(
      () => newClient().send('hteth', 'w1', { address: '0xabc', amount: '1' }),
      (err) => err instanceof BitGoError && err.code === 'UNSUPPORTED_WALLET_TYPE',
    )
    // Only the wallet metadata fetch was made — no send attempted
    assert.equal(calls.length, 1)
  })

  it('rejects cold wallets with UNSUPPORTED_WALLET_TYPE', async () => {
    mockFetch([{ body: { id: 'w1', type: 'cold', multisigType: 'onchain' } }])
    await assert.rejects(
      () => newClient().send('hteth', 'w1', { address: '0xabc', amount: '1' }),
      (err) => err instanceof BitGoError && err.code === 'UNSUPPORTED_WALLET_TYPE',
    )
  })

  it('rejects unsupported multisigType (e.g. blsdkg)', async () => {
    mockFetch([{ body: { id: 'w1', type: 'custodial', multisigType: 'blsdkg' } }])
    await assert.rejects(
      () => newClient().send('hteth', 'w1', { address: '0xabc', amount: '1' }),
      (err) => err instanceof BitGoError && err.code === 'UNSUPPORTED_MULTISIG_TYPE',
    )
  })

  it('requires address and amount before doing any wallet detection', async () => {
    const client = newClient()
    await assert.rejects(
      () => client.send('hteth', 'w1', { amount: '1' }),
      (err) => err instanceof BitGoError && err.code === 'MISSING_ADDRESS',
    )
    await assert.rejects(
      () => client.send('hteth', 'w1', { address: '0xabc' }),
      (err) => err instanceof BitGoError && err.code === 'MISSING_AMOUNT',
    )
    assert.equal(calls.length, 0)
  })
})

// ── Webhook auto-registration on pending ────────────────────────

describe('send: register-webhook-on-pending', () => {
  it('registers a webhook after a pending result when the flag is set', async () => {
    mockFetch([
      { body: { id: 'w1', type: 'custodial', multisigType: 'onchain' } },
      { body: { pendingApproval: { id: 'pa-1' } } },
      { body: { id: 'wh-1', url: 'https://example.com/hook' } },
    ])

    const result = await newClient().send('hteth', 'w1', {
      address: '0xabc',
      amount: '1',
      registerWebhookOnPending: true,
      webhookUrl: 'https://example.com/hook',
    })

    // The third call is the webhook registration
    assert.equal(calls[2].url, `${API_URL}/hteth/wallet/w1/webhooks`)
    assert.equal(calls[2].options.method, 'POST')
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      url: 'https://example.com/hook',
      type: 'pendingApproval',
    })
    assert.equal(result.webhookRegistration?.registered, true)
  })

  it('reports webhook registration failure as a side note, not a thrown error', async () => {
    mockFetch([
      { body: { id: 'w1', type: 'custodial', multisigType: 'onchain' } },
      { body: { pendingApproval: { id: 'pa-1' } } },
      { status: 500, body: { error: 'webhook server unavailable', name: 'WebhookError' } },
    ])

    const result = await newClient().send('hteth', 'w1', {
      address: '0xabc',
      amount: '1',
      registerWebhookOnPending: true,
      webhookUrl: 'https://example.com/hook',
    })

    // Send result still surfaces; webhook failure is a side note
    assert.equal(result.status, 'pending-approval')
    assert.equal(result.pendingApprovalId, 'pa-1')
    assert.equal(result.webhookRegistration?.registered, false)
    assert.match(result.webhookRegistration?.error, /webhook server unavailable/)
  })

  it('does not call addWebhook when register flag is unset', async () => {
    mockFetch([
      { body: { id: 'w1', type: 'custodial', multisigType: 'onchain' } },
      { body: { pendingApproval: { id: 'pa-1' } } },
    ])

    await newClient().send('hteth', 'w1', { address: '0xabc', amount: '1' })
    assert.equal(calls.length, 2)
  })
})

// ── Read-only tx queries ────────────────────────────────────────

describe('transaction + transfer reads', () => {
  it('getTransaction GETs /:coin/wallet/:id/tx/:txid', async () => {
    mockFetch([{ body: { id: 'tx-1' } }])
    await newClient().getTransaction('hteth', 'w1', 'tx-1')
    assert.equal(calls[0].url, `${API_URL}/hteth/wallet/w1/tx/tx-1`)
  })

  it('listTransactions GETs /:coin/wallet/:id/tx with pagination', async () => {
    mockFetch([{ body: { transactions: [] } }])
    await newClient().listTransactions('hteth', 'w1', { limit: 5, prevId: 'p1' })
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, '/api/v2/hteth/wallet/w1/tx')
    assert.equal(url.searchParams.get('limit'), '5')
    assert.equal(url.searchParams.get('prevId'), 'p1')
  })

  it('getTransfer GETs /:coin/wallet/:id/transfer/:id', async () => {
    mockFetch([{ body: { id: 'tr-1' } }])
    await newClient().getTransfer('hteth', 'w1', 'tr-1')
    assert.equal(calls[0].url, `${API_URL}/hteth/wallet/w1/transfer/tr-1`)
  })

  it('listTransfers GETs /:coin/wallet/:id/transfer', async () => {
    mockFetch([{ body: { transfers: [] } }])
    await newClient().listTransfers('hteth', 'w1')
    assert.equal(calls[0].url, `${API_URL}/hteth/wallet/w1/transfer`)
  })

  it('getTxRequest GETs /wallet/:id/txrequests/:id (no coin prefix)', async () => {
    mockFetch([{ body: { txRequestId: 'tr-1' } }])
    await newClient().getTxRequest('w1', 'tr-1')
    assert.equal(calls[0].url, `${API_URL}/wallet/w1/txrequests/tr-1`)
  })

  it('listTxRequests GETs /wallet/:id/txrequests', async () => {
    mockFetch([{ body: { txRequests: [] } }])
    await newClient().listTxRequests('w1')
    assert.equal(calls[0].url, `${API_URL}/wallet/w1/txrequests`)
  })
})

// ── New endpoints: create-address, maximum-spendable, fee-estimate ──

describe('createAddress + maximumSpendable + feeEstimate', () => {
  it('createAddress POSTs to /:coin/wallet/:id/address with label and chain', async () => {
    mockFetch([{ body: { id: 'a-1', address: '0x...' } }])
    await newClient().createAddress('hteth', 'w1', { label: 'cold-storage', chain: 0 })
    assert.equal(calls[0].url, `${API_URL}/hteth/wallet/w1/address`)
    assert.equal(calls[0].options.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].options.body), { label: 'cold-storage', chain: 0 })
  })

  it('createAddress sends an empty body when no options are provided', async () => {
    mockFetch([{ body: { id: 'a-1' } }])
    await newClient().createAddress('hteth', 'w1')
    assert.deepEqual(JSON.parse(calls[0].options.body), {})
  })

  it('maximumSpendable GETs /:coin/wallet/:id/maximumSpendable', async () => {
    mockFetch([{ body: { maximumSpendable: '999' } }])
    await newClient().maximumSpendable('hteth', 'w1', { feeRate: '1000' })
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, '/api/v2/hteth/wallet/w1/maximumSpendable')
    assert.equal(url.searchParams.get('feeRate'), '1000')
  })

  it('feeEstimate GETs /:coin/tx/fee', async () => {
    mockFetch([{ body: { feePerKb: 1000 } }])
    await newClient().feeEstimate('hteth')
    assert.equal(calls[0].url, `${API_URL}/hteth/tx/fee`)
  })
})

// ── Session unlock ──────────────────────────────────────────────

describe('unlock', () => {
  it('POSTs to /user/unlock with the otp and duration', async () => {
    mockFetch([{ body: { session: { id: 's-1' } } }])
    await newClient().unlock({ otp: '000000', duration: 600 })
    assert.equal(calls[0].url, `${API_URL}/user/unlock`)
    assert.equal(calls[0].options.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].options.body), { otp: '000000', duration: 600 })
  })

  it('requires an otp', async () => {
    await assert.rejects(
      () => newClient().unlock({}),
      (err) => err instanceof BitGoError && err.code === 'MISSING_OTP',
    )
  })
})
