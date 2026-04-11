/**
 * BitGoClient unit tests.
 *
 * Mocks `fetch` globally so we can test the client without hitting
 * the real BitGo API. Each test sets up the mock for one or more
 * call cycles, runs the client method, and asserts on:
 *
 *   - the URL the client called (path + query string)
 *   - the request method, headers, and body
 *   - the parsed result the client returned
 *   - the BitGoError code on failure paths
 *
 * Run with: npm test
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

/**
 * Install a fetch mock that returns the supplied responses in order.
 * Each response is an object with at least { status, body }.
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

describe('BitGoClient: construction', () => {
  it('rejects construction without an access token', () => {
    assert.throws(
      () => new BitGoClient({}),
      (err) => err instanceof BitGoError && err.code === 'MISSING_ACCESS_TOKEN',
    )
  })

  it('strips trailing slashes from the api url', () => {
    const client = new BitGoClient({
      accessToken: ACCESS_TOKEN,
      apiUrl: 'https://app.bitgo-test.com/api/v2///',
    })
    assert.equal(client.apiUrl, 'https://app.bitgo-test.com/api/v2')
  })

  it('uses the production url by default', () => {
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN })
    assert.equal(client.apiUrl, 'https://app.bitgo.com/api/v2')
  })
})

describe('BitGoClient: getWallet + caching', () => {
  it('fetches wallet metadata and sends Bearer auth', async () => {
    mockFetch([{ body: { id: 'w1', coin: 'btc', multisigType: 'tss' } }])
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })

    const wallet = await client.getWallet('btc', 'w1')

    assert.equal(wallet.id, 'w1')
    assert.equal(wallet.multisigType, 'tss')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${API_URL}/btc/wallet/w1`)
    assert.equal(calls[0].options.method ?? 'GET', 'GET')
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`)
  })

  it('caches wallet metadata across calls within the same client', async () => {
    mockFetch([{ body: { id: 'w1', multisigType: 'tss' } }])
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })

    await client.getWallet('btc', 'w1')
    await client.getWallet('btc', 'w1')

    // Only one fetch despite two getWallet calls
    assert.equal(calls.length, 1)
  })

  it('cache is keyed by (coin, walletId), not just walletId', async () => {
    mockFetch([
      { body: { id: 'w1', multisigType: 'tss' } },
      { body: { id: 'w1', multisigType: 'onchain' } },
    ])
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })

    await client.getWallet('btc', 'w1')
    await client.getWallet('eth', 'w1')

    assert.equal(calls.length, 2)
  })
})

describe('BitGoClient: detectWalletType', () => {
  it('returns { type, multisigType } from the wallet metadata', async () => {
    mockFetch([{ body: { id: 'w1', type: 'custodial', multisigType: 'tss' } }])
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })
    assert.deepEqual(await client.detectWalletType('btc', 'w1'), {
      type: 'custodial',
      multisigType: 'tss',
    })
  })

  it('falls back to custodial+onchain when fields are missing', async () => {
    mockFetch([{ body: { id: 'w1' } }])
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })
    assert.deepEqual(await client.detectWalletType('btc', 'w1'), {
      type: 'custodial',
      multisigType: 'onchain',
    })
  })

  it('reuses the wallet cache (no extra fetch)', async () => {
    mockFetch([{ body: { id: 'w1', type: 'custodial', multisigType: 'tss' } }])
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })

    await client.getWallet('btc', 'w1')
    await client.detectWalletType('btc', 'w1')

    assert.equal(calls.length, 1)
  })
})

describe('BitGoClient: listWallets', () => {
  it('passes pagination params as query string', async () => {
    mockFetch([{ body: { wallets: [], nextBatchPrevId: 'cursor1' } }])
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })

    await client.listWallets('btc', { limit: 25, prevId: 'cursor0' })

    const url = new URL(calls[0].url)
    assert.equal(url.pathname, '/api/v2/btc/wallet')
    assert.equal(url.searchParams.get('limit'), '25')
    assert.equal(url.searchParams.get('prevId'), 'cursor0')
  })

  it('uses the constructor enterprise-id by default', async () => {
    mockFetch([{ body: { wallets: [] } }])
    const client = new BitGoClient({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
      enterpriseId: 'ent1',
    })

    await client.listWallets('btc')

    assert.equal(new URL(calls[0].url).searchParams.get('enterprise'), 'ent1')
  })

  it('caller-supplied enterpriseId overrides the constructor default', async () => {
    mockFetch([{ body: { wallets: [] } }])
    const client = new BitGoClient({
      accessToken: ACCESS_TOKEN,
      apiUrl: API_URL,
      enterpriseId: 'ent1',
    })

    await client.listWallets('btc', { enterpriseId: 'ent2' })

    assert.equal(new URL(calls[0].url).searchParams.get('enterprise'), 'ent2')
  })
})

describe('BitGoClient: getBalance', () => {
  it('returns a structured balance object derived from wallet metadata', async () => {
    mockFetch([
      {
        body: {
          id: 'w1',
          balanceString: '1500000',
          confirmedBalanceString: '1450000',
          spendableBalanceString: '1400000',
        },
      },
    ])
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })

    const balance = await client.getBalance('btc', 'w1')

    assert.deepEqual(balance, {
      coin: 'btc',
      walletId: 'w1',
      balance: '1500000',
      confirmedBalance: '1450000',
      spendableBalance: '1400000',
    })
  })

  it('falls back to numeric balance fields if string variants are absent', async () => {
    mockFetch([{ body: { id: 'w1', balance: 100, confirmedBalance: 90, spendableBalance: 80 } }])
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })

    const balance = await client.getBalance('btc', 'w1')
    assert.equal(balance.balance, '100')
    assert.equal(balance.confirmedBalance, '90')
    assert.equal(balance.spendableBalance, '80')
  })
})

describe('BitGoClient: missing required params', () => {
  it('throws MISSING_COIN when coin is empty', async () => {
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })
    await assert.rejects(
      () => client.getWallet('', 'w1'),
      (err) => err instanceof BitGoError && err.code === 'MISSING_COIN',
    )
  })

  it('throws MISSING_WALLET_ID when wallet-id is empty', async () => {
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })
    await assert.rejects(
      () => client.getWallet('btc', ''),
      (err) => err instanceof BitGoError && err.code === 'MISSING_WALLET_ID',
    )
  })

  it('throws MISSING_BODY when create-wallet is called without a body', async () => {
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })
    await assert.rejects(
      () => client.createWallet('btc', null),
      (err) => err instanceof BitGoError && err.code === 'MISSING_BODY',
    )
  })

  it('throws MISSING_SHARE_WITH_USER when share target is missing', async () => {
    const client = new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })
    await assert.rejects(
      () => client.shareWallet('btc', 'w1', { user: '', permissions: 'view' }),
      (err) => err instanceof BitGoError && err.code === 'MISSING_SHARE_WITH_USER',
    )
  })
})
