/**
 * Live integration tests against the real BitGo test API.
 *
 * Skipped unless `BITGO_LIVE_TEST=1` is set in the environment.
 * Required env vars when enabled:
 *   - BITGO_ACCESS_TOKEN — long-lived test access token
 *   - BITGO_API_URL      — typically https://app.bitgo-test.com/api/v2
 *   - BITGO_TEST_COIN    — typically `hteth`
 *   - BITGO_TEST_WALLET_ID — a custodial multi-sig OR custodial TSS wallet
 *
 * What it covers:
 *   1. Read-only sweep across every endpoint we surface, to catch
 *      regressions caused by paths that don't exist on the platform
 *      API (the original Tier 2 was built on BitGo Express paths
 *      and the mocked tests didn't catch it).
 *   2. A real send-to-self that exercises the multi-sig
 *      tx/initiate path → pendingApproval → wait-for-approval loop.
 *      Self-send so the wallet doesn't actually lose funds — only
 *      gas is consumed.
 *
 * Why this exists: mocked tests can't tell you whether a URL is
 * real on the platform API. Live tests can. We always want both.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BitGoClient } from '../src/bitgo.js'

const LIVE = process.env.BITGO_LIVE_TEST === '1'
const ACCESS_TOKEN = process.env.BITGO_ACCESS_TOKEN
const API_URL = process.env.BITGO_API_URL
const COIN = process.env.BITGO_TEST_COIN || 'hteth'
const WALLET_ID = process.env.BITGO_TEST_WALLET_ID
const OTP = process.env.BITGO_TEST_OTP || '000000'

const skip = !LIVE
const reason = 'BITGO_LIVE_TEST != 1; skipping live integration suite'

function client() {
  return new BitGoClient({ accessToken: ACCESS_TOKEN, apiUrl: API_URL })
}

describe('live: read-only endpoint sweep', { skip, todo: skip ? reason : undefined }, () => {
  it('lists wallets for the configured coin', async () => {
    const r = await client().listWallets(COIN, { limit: 1 })
    assert.ok(Array.isArray(r.wallets), 'wallets array')
  })

  it('gets the configured test wallet', async () => {
    const r = await client().getWallet(COIN, WALLET_ID)
    assert.equal(r.id, WALLET_ID)
    assert.ok(r.coin)
  })

  it('reports balance for the test wallet', async () => {
    const r = await client().getBalance(COIN, WALLET_ID)
    assert.equal(r.walletId, WALLET_ID)
    assert.ok(typeof r.spendableBalance === 'string')
  })

  it('lists addresses', async () => {
    const r = await client().listAddresses(COIN, WALLET_ID, { limit: 5 })
    assert.ok(Array.isArray(r.addresses))
  })

  it('lists transactions', async () => {
    const r = await client().listTransactions(COIN, WALLET_ID, { limit: 1 })
    assert.ok(r.coin || Array.isArray(r.transactions))
  })

  it('lists transfers', async () => {
    const r = await client().listTransfers(COIN, WALLET_ID, { limit: 1 })
    assert.ok(r.coin || Array.isArray(r.transfers))
  })

  it('lists tx requests (TSS)', async () => {
    const r = await client().listTxRequests(WALLET_ID)
    assert.ok(r)
  })

  it('reports maximum spendable', async () => {
    const r = await client().maximumSpendable(COIN, WALLET_ID)
    assert.ok(r)
  })

  it('reports a fee estimate', async () => {
    const r = await client().feeEstimate(COIN)
    assert.ok(r)
  })

  it('lists policies', async () => {
    const r = await client().listPolicies(COIN, WALLET_ID)
    assert.equal(r.coin, COIN)
    assert.ok(Array.isArray(r.rules))
  })

  it('lists pending approvals scoped to the wallet', async () => {
    const r = await client().listPendingApprovals({ walletId: WALLET_ID })
    assert.ok(r)
  })

  it('lists wallet webhooks', async () => {
    const r = await client().listWebhooks(COIN, WALLET_ID)
    assert.ok(r)
  })
})

describe('live: batch send (multi-recipient)', { skip, todo: skip ? reason : undefined }, () => {
  it('accepts a recipients array with two entries via the same path', async () => {
    const c = client()
    await c.unlock({ otp: OTP, duration: 600 })

    const wallet = await c.getWallet(COIN, WALLET_ID)
    const receiveAddress = wallet.receiveAddress?.address || wallet.coinSpecific?.baseAddress
    assert.ok(receiveAddress, 'wallet must have a receive address')

    const sendResult = await c.send(COIN, WALLET_ID, {
      recipients: [
        { address: receiveAddress, amount: '1000000000000' },
        { address: receiveAddress, amount: '2000000000000' },
      ],
      comment: 'w3-bitgo-action live batch test',
    })

    assert.equal(sendResult.status, 'pending-approval')
    assert.ok(sendResult.pendingApprovalId || sendResult.txRequestId)
    assert.ok(sendResult.correlationId)
  })
})

describe(
  'live: end-to-end send (self-send, exercises tx/initiate or txrequests)',
  { skip, todo: skip ? reason : undefined },
  () => {
    it('unlocks, sends 1e15 to its own receive address, and watches the approval', async () => {
      const c = client()

      // 1. Unlock the session — sends are gated behind a recent unlock.
      await c.unlock({ otp: OTP, duration: 600 })

      // 2. Look up the wallet's own receive address so the funds
      //    don't actually leave the wallet — only gas is consumed.
      const wallet = await c.getWallet(COIN, WALLET_ID)
      const receiveAddress = wallet.receiveAddress?.address || wallet.coinSpecific?.baseAddress
      assert.ok(receiveAddress, 'wallet must have a receive address')

      // 3. Send.
      const sendResult = await c.send(COIN, WALLET_ID, {
        address: receiveAddress,
        amount: '1000000000000000', // 0.001 hteth
        comment: 'w3-bitgo-action live integration test',
      })

      // The TSS path returns a txRequestId, the multi-sig path
      // returns a pendingApprovalId. Both should produce one or
      // the other, with the uniform pending-approval status.
      assert.equal(sendResult.status, 'pending-approval')
      assert.ok(
        sendResult.pendingApprovalId || sendResult.txRequestId,
        'send must return either a pendingApprovalId or a txRequestId',
      )
      assert.ok(sendResult.correlationId, 'send must include a correlation ID')

      // 4. If we got a pending approval, exercise wait-for-approval
      //    against it with a generous timeout. This validates the
      //    full Layer 2 polling path against real BitGo state.
      if (sendResult.pendingApprovalId) {
        const final = await c.waitForApproval(sendResult.pendingApprovalId, { timeout: 120 })
        assert.ok(
          ['approved', 'rejected', 'timeout'].includes(final.status),
          `wait-for-approval terminal state: ${final.status}`,
        )
      }
    })
  },
)
