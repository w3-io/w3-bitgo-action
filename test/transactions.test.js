/**
 * BitGoClient transaction + signing tests (Tier 2).
 *
 * Covers:
 *   - sendTransaction happy path (sent state, txHash extraction)
 *   - sendTransaction pending-approval translation
 *   - correlation ID generation and preservation
 *   - register-webhook-on-pending Layer 3 hook
 *   - wallet-type validation (TSS allowed, onchain allowed,
 *     coldStorage / blsdkg rejected with UNSUPPORTED_WALLET_TYPE)
 *   - send-many recipients validation
 *   - sweep, consolidate, accelerate-transaction shapes
 *   - get-transaction / list-transactions read paths
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { BitGoClient, BitGoError } from '../src/bitgo.js'

const ACCESS_TOKEN = 'v2x_test_token'
const PASSPHRASE = 'correct horse battery staple'
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

/**
 * Install a fetch mock that returns the supplied responses in order.
 * Each response is { status?: number, body?: object }.
 */
function mockFetch(responses) {
  let index = 0
  global.fetch = async (url, options) => {
    calls.push({ url, options })
    const response = responses[index++]
    if (!response) {
      throw new Error(`Unexpected fetch call ${index}: ${url}`)
    }
    const status = response.status ?? 200
    const ok = status >= 200 && status < 300
    return {
      ok,
      status,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify(response.body ?? {}),
      json: async () => response.body ?? {},
    }
  }
}

function makeClient(opts = {}) {
  return new BitGoClient({
    accessToken: ACCESS_TOKEN,
    apiUrl: API_URL,
    ...opts,
  })
}

/**
 * Parse the JSON body of the most recent recorded fetch call.
 * Helps tests assert against what BitGoClient actually sent.
 */
function lastBody() {
  const body = calls[calls.length - 1].options.body
  // action-core's request helper accepts an object and serializes
  // internally, but our mock receives whatever request() forwarded.
  return typeof body === 'string' ? JSON.parse(body) : body
}

describe('BitGoClient.sendTransaction: happy path', () => {
  it('returns sent status with txHash on success', async () => {
    mockFetch([
      // First call: detectWalletType / getWallet
      { body: { id: 'w1', multisigType: 'tss' } },
      // Second call: sendcoins
      { body: { txid: '0xabc123', transfer: { state: 'signed' } } },
    ])
    const client = makeClient()

    const result = await client.sendTransaction('btc', 'w1', {
      address: 'bc1qtest',
      amount: '50000',
      walletPassphrase: PASSPHRASE,
    })

    assert.equal(result.status, 'sent')
    assert.equal(result.txHash, '0xabc123')
    assert.ok(result.correlationId, 'correlation id should be auto-generated')
    assert.equal(calls.length, 2)
    assert.match(calls[1].url, /\/btc\/wallet\/w1\/sendcoins$/)
  })

  it('uses caller-supplied correlation ID when provided', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'tss' } }, { body: { txid: '0xabc' } }])
    const client = makeClient()

    const result = await client.sendTransaction('btc', 'w1', {
      address: 'bc1qtest',
      amount: '50000',
      walletPassphrase: PASSPHRASE,
      correlationId: 'caller-supplied-id',
    })

    assert.equal(result.correlationId, 'caller-supplied-id')
  })

  it('embeds the correlation ID in the comment field', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'tss' } }, { body: { txid: '0xabc' } }])
    const client = makeClient()

    await client.sendTransaction('btc', 'w1', {
      address: 'bc1qtest',
      amount: '50000',
      walletPassphrase: PASSPHRASE,
      correlationId: 'fixed-id',
      comment: 'monthly payout',
    })

    const sendBody = lastBody()
    assert.equal(sendBody.comment, 'monthly payout [w3-corr:fixed-id]')
  })

  it('extracts txHash from EVM-shaped responses', async () => {
    mockFetch([
      { body: { id: 'w1', multisigType: 'tss' } },
      { body: { transfer: { txHash: '0xdeadbeef' } } },
    ])
    const client = makeClient()

    const result = await client.sendTransaction('eth', 'w1', {
      address: '0xrecipient',
      amount: '1000000000000000000',
      walletPassphrase: PASSPHRASE,
    })

    assert.equal(result.txHash, '0xdeadbeef')
  })
})

describe('BitGoClient.sendTransaction: pending approval', () => {
  it('translates pendingApproval into status="pending-approval"', async () => {
    mockFetch([
      { body: { id: 'w1', multisigType: 'tss' } },
      { body: { pendingApproval: { id: 'pa-123', state: 'pending' } } },
    ])
    const client = makeClient()

    const result = await client.sendTransaction('btc', 'w1', {
      address: 'bc1qtest',
      amount: '5000000000', // a big enough amount to trigger a policy
      walletPassphrase: PASSPHRASE,
    })

    assert.equal(result.status, 'pending-approval')
    assert.equal(result.pendingApprovalId, 'pa-123')
    assert.ok(result.correlationId, 'correlation id should still be present')
    assert.deepEqual(result.raw.pendingApproval, { id: 'pa-123', state: 'pending' })
  })

  it('handles flatter status="pendingApproval" response shape', async () => {
    mockFetch([
      { body: { id: 'w1', multisigType: 'tss' } },
      { body: { status: 'pendingApproval', pendingApprovalId: 'pa-456' } },
    ])
    const client = makeClient()

    const result = await client.sendTransaction('btc', 'w1', {
      address: 'bc1qtest',
      amount: '50000',
      walletPassphrase: PASSPHRASE,
    })

    assert.equal(result.status, 'pending-approval')
    assert.equal(result.pendingApprovalId, 'pa-456')
  })

  it('auto-registers webhook when register-webhook-on-pending is set', async () => {
    mockFetch([
      // detectWalletType
      { body: { id: 'w1', multisigType: 'tss' } },
      // sendcoins → pending approval
      { body: { pendingApproval: { id: 'pa-123' } } },
      // addWebhook
      { body: { id: 'wh-123', url: 'https://example.com/cb', type: 'pendingApproval' } },
    ])
    const client = makeClient()

    const result = await client.sendTransaction('btc', 'w1', {
      address: 'bc1qtest',
      amount: '50000',
      walletPassphrase: PASSPHRASE,
      registerWebhookOnPending: true,
      webhookUrl: 'https://example.com/cb',
    })

    assert.equal(result.status, 'pending-approval')
    assert.equal(result.webhookRegistration.attempted, true)
    assert.equal(result.webhookRegistration.registered, true)
    assert.equal(result.webhookRegistration.url, 'https://example.com/cb')
    assert.equal(calls.length, 3)
    assert.match(calls[2].url, /\/btc\/wallet\/w1\/webhooks$/)
  })

  it('reports webhook registration failure as a side note, not a thrown error', async () => {
    mockFetch([
      { body: { id: 'w1', multisigType: 'tss' } },
      { body: { pendingApproval: { id: 'pa-123' } } },
      // addWebhook fails
      { status: 500, body: { error: 'webhook service down' } },
    ])
    const client = makeClient()

    const result = await client.sendTransaction('btc', 'w1', {
      address: 'bc1qtest',
      amount: '50000',
      walletPassphrase: PASSPHRASE,
      registerWebhookOnPending: true,
      webhookUrl: 'https://example.com/cb',
    })

    assert.equal(result.status, 'pending-approval')
    assert.equal(result.webhookRegistration.attempted, true)
    assert.equal(result.webhookRegistration.registered, false)
    assert.ok(result.webhookRegistration.error)
  })

  it('does not call addWebhook when register flag is unset', async () => {
    mockFetch([
      { body: { id: 'w1', multisigType: 'tss' } },
      { body: { pendingApproval: { id: 'pa-123' } } },
    ])
    const client = makeClient()

    await client.sendTransaction('btc', 'w1', {
      address: 'bc1qtest',
      amount: '50000',
      walletPassphrase: PASSPHRASE,
      webhookUrl: 'https://example.com/cb', // url provided but flag not set
    })

    assert.equal(calls.length, 2, 'should not have called addWebhook')
  })
})

describe('BitGoClient: wallet-type validation', () => {
  it('allows tss wallets', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'tss' } }, { body: { txid: '0xabc' } }])
    const client = makeClient()
    await assert.doesNotReject(() =>
      client.sendTransaction('btc', 'w1', {
        address: 'bc1qtest',
        amount: '50000',
        walletPassphrase: PASSPHRASE,
      }),
    )
  })

  it('allows onchain (multi-sig) wallets', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'onchain' } }, { body: { txid: '0xabc' } }])
    const client = makeClient()
    await assert.doesNotReject(() =>
      client.sendTransaction('btc', 'w1', {
        address: 'bc1qtest',
        amount: '50000',
        walletPassphrase: PASSPHRASE,
      }),
    )
  })

  it('rejects blsdkg wallets with UNSUPPORTED_WALLET_TYPE', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'blsdkg' } }])
    const client = makeClient()
    await assert.rejects(
      () =>
        client.sendTransaction('eth2', 'w1', {
          address: '0xrecipient',
          amount: '32000000000000000000',
          walletPassphrase: PASSPHRASE,
        }),
      (err) => err instanceof BitGoError && err.code === 'UNSUPPORTED_WALLET_TYPE',
    )
  })

  it('rejects unknown wallet types', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'cold' } }])
    const client = makeClient()
    await assert.rejects(
      () =>
        client.sendTransaction('btc', 'w1', {
          address: 'bc1qtest',
          amount: '50000',
          walletPassphrase: PASSPHRASE,
        }),
      (err) => err instanceof BitGoError && err.code === 'UNSUPPORTED_WALLET_TYPE',
    )
  })
})

describe('BitGoClient.buildTransaction', () => {
  it('builds with recipients array and forwards feeRate', async () => {
    mockFetch([{ body: { txHex: '0x...', fee: '500' } }])
    const client = makeClient()

    await client.buildTransaction('btc', 'w1', {
      address: 'bc1qtest',
      amount: '50000',
      feeRate: '20',
    })

    const body = lastBody()
    assert.deepEqual(body.recipients, [{ address: 'bc1qtest', amount: '50000' }])
    assert.equal(body.feeRate, '20')
    assert.match(calls[0].url, /\/btc\/wallet\/w1\/tx\/build$/)
  })

  it('omits feeRate when not supplied', async () => {
    mockFetch([{ body: {} }])
    const client = makeClient()

    await client.buildTransaction('btc', 'w1', {
      address: 'bc1qtest',
      amount: '50000',
    })

    assert.equal(lastBody().feeRate, undefined)
  })
})

describe('BitGoClient.sendMany', () => {
  it('forwards recipients and embeds correlation in comment', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'tss' } }, { body: { txid: '0xbatch' } }])
    const client = makeClient()

    const body = {
      recipients: [
        { address: 'bc1q1', amount: '1000' },
        { address: 'bc1q2', amount: '2000' },
      ],
    }

    const result = await client.sendMany('btc', 'w1', {
      walletPassphrase: PASSPHRASE,
      body,
      correlationId: 'corr-batch',
    })

    assert.equal(result.status, 'sent')
    assert.equal(result.txHash, '0xbatch')
    const sent = lastBody()
    assert.equal(sent.recipients.length, 2)
    assert.equal(sent.comment, '[w3-corr:corr-batch]')
  })

  it('rejects empty recipients array', async () => {
    const client = makeClient()
    await assert.rejects(
      () =>
        client.sendMany('btc', 'w1', {
          walletPassphrase: PASSPHRASE,
          body: { recipients: [] },
        }),
      (err) => err instanceof BitGoError && err.code === 'INVALID_BODY',
    )
  })

  it('rejects missing recipients field', async () => {
    const client = makeClient()
    await assert.rejects(
      () =>
        client.sendMany('btc', 'w1', {
          walletPassphrase: PASSPHRASE,
          body: { foo: 'bar' },
        }),
      (err) => err instanceof BitGoError && err.code === 'INVALID_BODY',
    )
  })

  it('rejects null body', async () => {
    const client = makeClient()
    await assert.rejects(
      () => client.sendMany('btc', 'w1', { walletPassphrase: PASSPHRASE, body: null }),
      (err) => err instanceof BitGoError && err.code === 'MISSING_BODY',
    )
  })
})

describe('BitGoClient.sweep + consolidate', () => {
  it('sweep posts to /sweep endpoint with address and passphrase', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'tss' } }, { body: { txid: '0xsweep' } }])
    const client = makeClient()

    await client.sweep('btc', 'w1', {
      address: 'bc1qsink',
      walletPassphrase: PASSPHRASE,
    })

    assert.match(calls[1].url, /\/btc\/wallet\/w1\/sweep$/)
    const body = lastBody()
    assert.equal(body.address, 'bc1qsink')
    assert.equal(body.walletPassphrase, PASSPHRASE)
  })

  it('consolidate posts to /consolidateUnspents and merges body', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'onchain' } }, { body: { txid: '0xconsol' } }])
    const client = makeClient()

    await client.consolidate('btc', 'w1', {
      walletPassphrase: PASSPHRASE,
      body: { numUnspentsToMake: 1, limit: 50 },
    })

    assert.match(calls[1].url, /\/btc\/wallet\/w1\/consolidateUnspents$/)
    const body = lastBody()
    assert.equal(body.numUnspentsToMake, 1)
    assert.equal(body.limit, 50)
    assert.equal(body.walletPassphrase, PASSPHRASE)
  })
})

describe('BitGoClient.accelerateTransaction', () => {
  it('sends cpfp tx ids and fee rate to accelerate endpoint', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'onchain' } }, { body: { txid: '0xaccel' } }])
    const client = makeClient()

    await client.accelerateTransaction('btc', 'w1', '0xstuck', {
      walletPassphrase: PASSPHRASE,
      feeRate: '50',
    })

    assert.match(calls[1].url, /\/btc\/wallet\/w1\/accelerateTransaction$/)
    const body = lastBody()
    assert.deepEqual(body.cpfpTxIds, ['0xstuck'])
    assert.equal(body.feeRate, '50')
  })

  it('throws MISSING_TX_ID when txId is empty', async () => {
    const client = makeClient()
    await assert.rejects(
      () =>
        client.accelerateTransaction('btc', 'w1', '', {
          walletPassphrase: PASSPHRASE,
        }),
      (err) => err instanceof BitGoError && err.code === 'MISSING_TX_ID',
    )
  })
})

describe('BitGoClient.getTransaction + listTransactions', () => {
  it('getTransaction issues a GET to /tx/:id', async () => {
    mockFetch([{ body: { id: '0xabc', state: 'confirmed' } }])
    const client = makeClient()

    const result = await client.getTransaction('btc', 'w1', '0xabc')

    assert.equal(result.id, '0xabc')
    assert.match(calls[0].url, /\/btc\/wallet\/w1\/tx\/0xabc$/)
  })

  it('listTransactions accepts pagination params', async () => {
    mockFetch([{ body: { transactions: [], nextBatchPrevId: 'cursor' } }])
    const client = makeClient()

    await client.listTransactions('btc', 'w1', { limit: 10, prevId: 'pre' })

    const url = new URL(calls[0].url)
    assert.equal(url.searchParams.get('limit'), '10')
    assert.equal(url.searchParams.get('prevId'), 'pre')
  })
})
