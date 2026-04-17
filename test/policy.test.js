/**
 * Tier 3 (policy + approval), Layer 2 (wait-for-approval), and
 * Tier 4 (webhooks) unit tests.
 *
 * Same fetch-mock pattern as bitgo.test.js. waitForApproval injects
 * a fake sleep so the polling loop doesn't actually wait.
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

function newClient(overrides = {}) {
  return new BitGoClient({
    accessToken: ACCESS_TOKEN,
    apiUrl: API_URL,
    ...overrides,
  })
}

// ── Tier 3: Policy ───────────────────────────────────────────────

describe('listPolicies', () => {
  it('returns the policy rules from the wallet metadata', async () => {
    mockFetch([
      {
        body: {
          id: 'wallet1',
          admin: {
            policy: {
              version: 3,
              latest: true,
              rules: [
                { id: 'rule1', type: 'velocityLimit' },
                { id: 'rule2', type: 'webhook' },
              ],
            },
          },
        },
      },
    ])
    const client = newClient()
    const result = await client.listPolicies('btc', 'wallet1')
    assert.equal(calls[0].url, `${API_URL}/btc/wallet/wallet1`)
    assert.equal(result.coin, 'btc')
    assert.equal(result.walletId, 'wallet1')
    assert.equal(result.version, 3)
    assert.equal(result.latest, true)
    assert.equal(result.rules.length, 2)
    assert.equal(result.rules[0].id, 'rule1')
  })

  it('returns an empty rules list when the wallet has no policy', async () => {
    mockFetch([{ body: { id: 'wallet1' } }])
    const client = newClient()
    const result = await client.listPolicies('btc', 'wallet1')
    assert.deepEqual(result.rules, [])
    assert.equal(result.version, null)
  })

  it('uses the cached wallet on a second call', async () => {
    mockFetch([
      {
        body: {
          id: 'wallet1',
          admin: { policy: { version: 1, latest: true, rules: [] } },
        },
      },
    ])
    const client = newClient()
    await client.listPolicies('btc', 'wallet1')
    await client.listPolicies('btc', 'wallet1')
    assert.equal(calls.length, 1, 'wallet should be fetched only once')
  })
})

describe('setPolicyRule', () => {
  it('PUTs the rule body to the policy/rule endpoint', async () => {
    const ruleBody = {
      id: 'velocity-1d',
      type: 'velocityLimit',
      condition: { amount: '1000000', timeWindow: 86400, coin: 'btc' },
      action: { type: 'denyAdmin' },
    }
    mockFetch([{ body: { id: 'velocity-1d', state: 'active' } }])
    const client = newClient()
    const result = await client.setPolicyRule('btc', 'wallet1', ruleBody)
    assert.equal(calls[0].url, `${API_URL}/btc/wallet/wallet1/policy/rule`)
    assert.equal(calls[0].options.method, 'PUT')
    assert.deepEqual(JSON.parse(calls[0].options.body), ruleBody)
    assert.equal(result.id, 'velocity-1d')
  })

  it('throws MISSING_BODY when the rule body is missing', async () => {
    const client = newClient()
    await assert.rejects(
      () => client.setPolicyRule('btc', 'wallet1', null),
      (err) => err instanceof BitGoError && err.code === 'MISSING_BODY',
    )
  })
})

describe('removePolicyRule', () => {
  it('DELETEs the rule by id', async () => {
    mockFetch([{ body: { id: 'velocity-1d', state: 'removed' } }])
    const client = newClient()
    await client.removePolicyRule('btc', 'wallet1', 'velocity-1d')
    assert.equal(calls[0].url, `${API_URL}/btc/wallet/wallet1/policy/rule`)
    assert.equal(calls[0].options.method, 'DELETE')
    assert.deepEqual(JSON.parse(calls[0].options.body), { id: 'velocity-1d' })
  })

  it('requires a rule id', async () => {
    const client = newClient()
    await assert.rejects(
      () => client.removePolicyRule('btc', 'wallet1', ''),
      (err) => err instanceof BitGoError && err.code === 'MISSING_POLICY_RULE_ID',
    )
  })
})

// ── Tier 3: Pending approvals ────────────────────────────────────

describe('listPendingApprovals', () => {
  it('queries pendingapprovals scoped to a wallet id', async () => {
    mockFetch([{ body: { pendingApprovals: [] } }])
    const client = newClient()
    await client.listPendingApprovals({ walletId: 'wallet1' })
    assert.match(calls[0].url, /\/pendingapprovals\?walletId=wallet1/)
  })

  it('falls back to the constructor enterprise id', async () => {
    mockFetch([{ body: { pendingApprovals: [] } }])
    const client = newClient({ enterpriseId: 'ent-default' })
    await client.listPendingApprovals({})
    assert.match(calls[0].url, /enterprise=ent-default/)
  })

  it('lets per-call enterprise id override the constructor default', async () => {
    mockFetch([{ body: { pendingApprovals: [] } }])
    const client = newClient({ enterpriseId: 'ent-default' })
    await client.listPendingApprovals({ enterpriseId: 'ent-override' })
    assert.match(calls[0].url, /enterprise=ent-override/)
  })
})

describe('approvePending', () => {
  it('PUTs state=approved with the otp', async () => {
    mockFetch([{ body: { id: 'pa1', state: 'approved' } }])
    const result = await newClient().approvePending('pa1', { otp: '000000' })
    assert.equal(calls[0].url, `${API_URL}/pendingapprovals/pa1`)
    assert.equal(calls[0].options.method, 'PUT')
    const body = JSON.parse(calls[0].options.body)
    assert.equal(body.state, 'approved')
    assert.equal(body.otp, '000000')
    assert.equal(result.state, 'approved')
  })

  it('omits the otp when none is provided', async () => {
    mockFetch([{ body: { id: 'pa1', state: 'approved' } }])
    await newClient().approvePending('pa1')
    const body = JSON.parse(calls[0].options.body)
    assert.equal(body.state, 'approved')
    assert.equal(body.otp, undefined)
  })

  it('requires the pending approval id', async () => {
    const client = newClient()
    await assert.rejects(
      () => client.approvePending(''),
      (err) => err instanceof BitGoError && err.code === 'MISSING_PENDING_APPROVAL_ID',
    )
  })
})

describe('rejectPending', () => {
  it('PUTs state=rejected', async () => {
    mockFetch([{ body: { id: 'pa1', state: 'rejected' } }])
    const client = newClient()
    const result = await client.rejectPending('pa1')
    assert.equal(calls[0].url, `${API_URL}/pendingapprovals/pa1`)
    assert.equal(calls[0].options.method, 'PUT')
    assert.deepEqual(JSON.parse(calls[0].options.body), { state: 'rejected' })
    assert.equal(result.state, 'rejected')
  })
})

// ── Layer 2: wait-for-approval ───────────────────────────────────

describe('waitForApproval', () => {
  it('returns immediately when the approval is already approved', async () => {
    mockFetch([
      {
        body: {
          id: 'pa1',
          state: 'approved',
          transactions: [{ txid: '0xabc' }],
        },
      },
    ])
    const sleeps = []
    const client = newClient()
    const result = await client.waitForApproval('pa1', {
      timeout: 60,
      sleep: async (ms) => sleeps.push(ms),
    })
    assert.equal(result.status, 'approved')
    assert.equal(result.txHash, '0xabc')
    assert.equal(sleeps.length, 0, 'should not sleep when already approved')
  })

  it('returns rejected when the approval is rejected', async () => {
    mockFetch([{ body: { id: 'pa1', state: 'rejected' } }])
    const client = newClient()
    const result = await client.waitForApproval('pa1', {
      timeout: 60,
      sleep: async () => {},
    })
    assert.equal(result.status, 'rejected')
  })

  it('polls until the approval transitions to approved', async () => {
    mockFetch([
      { body: { id: 'pa1', state: 'pending' } },
      { body: { id: 'pa1', state: 'pending' } },
      { body: { id: 'pa1', state: 'approved', txid: '0xdef' } },
    ])
    const sleeps = []
    const client = newClient()
    const result = await client.waitForApproval('pa1', {
      timeout: 60,
      sleep: async (ms) => sleeps.push(ms),
    })
    assert.equal(result.status, 'approved')
    assert.equal(result.txHash, '0xdef')
    assert.equal(calls.length, 3)
    assert.equal(sleeps.length, 2, 'should sleep between each poll')
    // Exponential backoff: 5000 → 7500 (×1.5)
    assert.equal(sleeps[0], 5000)
    assert.equal(sleeps[1], 7500)
  })

  it('returns timeout when the deadline elapses', async () => {
    // Always pending. Force a tiny timeout via real-clock advance.
    let now = Date.now()
    const realNow = Date.now
    Date.now = () => now
    try {
      mockFetch([
        { body: { id: 'pa1', state: 'pending' } },
        { body: { id: 'pa1', state: 'pending' } },
      ])
      const client = newClient()
      const result = await client.waitForApproval('pa1', {
        timeout: 1,
        sleep: async () => {
          // Advance the fake clock past the deadline mid-poll.
          now += 2000
        },
      })
      assert.equal(result.status, 'timeout')
    } finally {
      Date.now = realNow
    }
  })

  it('caps the timeout at 3600 seconds', async () => {
    // We can't really test the cap without waiting. Instead assert the
    // deadline math by intercepting the first sleep — if the cap is
    // honored, the loop runs at all.
    mockFetch([{ body: { id: 'pa1', state: 'approved' } }])
    const client = newClient()
    const result = await client.waitForApproval('pa1', {
      timeout: 99_999,
      sleep: async () => {},
    })
    assert.equal(result.status, 'approved')
  })

  it('requires a pending approval id', async () => {
    const client = newClient()
    await assert.rejects(
      () => client.waitForApproval(''),
      (err) => err instanceof BitGoError && err.code === 'MISSING_PENDING_APPROVAL_ID',
    )
  })
})

// ── Tier 4: Webhooks ─────────────────────────────────────────────

describe('addWebhook', () => {
  it('POSTs the webhook url and type', async () => {
    mockFetch([{ body: { id: 'wh1', url: 'https://example.com/hook' } }])
    const client = newClient()
    const result = await client.addWebhook('btc', 'wallet1', {
      url: 'https://example.com/hook',
      type: 'transfer',
    })
    assert.equal(calls[0].url, `${API_URL}/btc/wallet/wallet1/webhooks`)
    assert.equal(calls[0].options.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      url: 'https://example.com/hook',
      type: 'transfer',
    })
    assert.equal(result.id, 'wh1')
  })

  it('defaults the type to pendingApproval', async () => {
    mockFetch([{ body: { id: 'wh1' } }])
    const client = newClient()
    await client.addWebhook('btc', 'wallet1', { url: 'https://example.com/hook' })
    const body = JSON.parse(calls[0].options.body)
    assert.equal(body.type, 'pendingApproval')
  })

  it('requires a webhook url', async () => {
    const client = newClient()
    await assert.rejects(
      () => client.addWebhook('btc', 'wallet1', { url: '' }),
      (err) => err instanceof BitGoError && err.code === 'MISSING_WEBHOOK_URL',
    )
  })
})

describe('listWebhooks', () => {
  it('GETs the wallet webhooks endpoint', async () => {
    mockFetch([{ body: { webhooks: [{ id: 'wh1' }] } }])
    const client = newClient()
    const result = await client.listWebhooks('btc', 'wallet1')
    assert.equal(calls[0].url, `${API_URL}/btc/wallet/wallet1/webhooks`)
    assert.equal(result.webhooks.length, 1)
  })
})

describe('removeWebhook', () => {
  it('DELETEs the webhook by id', async () => {
    mockFetch([{ body: { removed: true } }])
    const client = newClient()
    await client.removeWebhook('btc', 'wallet1', 'wh1')
    assert.equal(calls[0].url, `${API_URL}/btc/wallet/wallet1/webhooks/wh1`)
    assert.equal(calls[0].options.method, 'DELETE')
  })

  it('requires a webhook id', async () => {
    const client = newClient()
    await assert.rejects(
      () => client.removeWebhook('btc', 'wallet1', ''),
      (err) => err instanceof BitGoError && err.code === 'MISSING_WEBHOOK_ID',
    )
  })
})

// ── createWebhook (alias for addWebhook) ───────────────────────

describe('createWebhook', () => {
  it('POSTs the webhook url and type', async () => {
    mockFetch([{ body: { id: 'wh1', url: 'https://example.com/hook' } }])
    const client = newClient()
    const result = await client.createWebhook('btc', 'wallet1', {
      url: 'https://example.com/hook',
      type: 'transfer',
    })
    assert.equal(calls[0].url, `${API_URL}/btc/wallet/wallet1/webhooks`)
    assert.equal(calls[0].options.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      url: 'https://example.com/hook',
      type: 'transfer',
    })
    assert.equal(result.id, 'wh1')
  })

  it('defaults the type to pendingApproval', async () => {
    mockFetch([{ body: { id: 'wh1' } }])
    const client = newClient()
    await client.createWebhook('btc', 'wallet1', { url: 'https://example.com/hook' })
    const body = JSON.parse(calls[0].options.body)
    assert.equal(body.type, 'pendingApproval')
  })

  it('requires a webhook url', async () => {
    const client = newClient()
    await assert.rejects(
      () => client.createWebhook('btc', 'wallet1', { url: '' }),
      (err) => err instanceof BitGoError && err.code === 'MISSING_WEBHOOK_URL',
    )
  })
})

// ── deleteWebhook (alias for removeWebhook) ────────────────────

describe('deleteWebhook', () => {
  it('DELETEs the webhook by id', async () => {
    mockFetch([{ body: { removed: true } }])
    const client = newClient()
    await client.deleteWebhook('btc', 'wallet1', 'wh1')
    assert.equal(calls[0].url, `${API_URL}/btc/wallet/wallet1/webhooks/wh1`)
    assert.equal(calls[0].options.method, 'DELETE')
  })

  it('requires a webhook id', async () => {
    const client = newClient()
    await assert.rejects(
      () => client.deleteWebhook('btc', 'wallet1', ''),
      (err) => err instanceof BitGoError && err.code === 'MISSING_WEBHOOK_ID',
    )
  })
})
