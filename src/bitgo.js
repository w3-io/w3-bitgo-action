/**
 * BitGo Platform API client (custodial wallets only).
 *
 * Wraps the BitGo Platform REST API at https://app.bitgo.com/api/v2
 * (or https://app.bitgo-test.com/api/v2 for the test environment).
 *
 * ## Why custodial-only
 *
 * The legacy "build + sign + broadcast" endpoints (`/sendcoins`,
 * `/sendmany`, `/consolidateUnspents`, `/sweep`, `/accelerateTransaction`)
 * are NOT exposed by `app.bitgo.com/api/v2`. They live in BitGo
 * Express — a self-hosted node service that bundles `@bitgo/sdk-core`
 * and runs the cryptographic signing locally before forwarding the
 * signed tx to the platform. Calling them on the platform API
 * returns "You have called a BitGo Express endpoint but this is the
 * BitGo server."
 *
 * Self-managed (hot) wallets fundamentally need either Express
 * running as a sidecar OR the SDK bundled in-process. Both options
 * blow up bundle size and add operational complexity that doesn't
 * fit a thin GitHub Action wrapper.
 *
 * Custodial wallets need neither. BitGo holds the keys and signs
 * server-side, so we can drive the entire send flow over the
 * platform REST API.
 *
 * ## Signing dispatch by wallet type
 *
 * Both flows converge on a `pendingApproval` that callers can poll
 * via `wait-for-approval` (Layer 2) or react to via webhook
 * (Layer 3).
 *
 *   • **TSS custodial** → `POST /wallet/:walletId/txrequests`
 *     (note: NO coin prefix). The body is an `intent` envelope
 *     with `recipients[].address.address` and
 *     `recipients[].amount.{value, symbol}`. BitGo signs because
 *     it holds both MPC shares.
 *
 *   • **Multi-sig (onchain) custodial** →
 *     `POST /:coin/wallet/:walletId/tx/initiate` with a flat
 *     `recipients` array. Returns HTTP 200 with body
 *     `{ error: "Awaiting transaction signature", pendingApproval }`.
 *     BitGo Trust signs and broadcasts.
 *
 * ## Session unlock
 *
 * Sensitive operations (sends, policy mutations) require a recent
 * unlock. Call `unlock({ otp, duration })` once at the start of a
 * sequence of mutating operations. The test environment accepts
 * the magic OTP `000000`; production needs a real TOTP from the
 * user's authenticator app, supplied via the `otp` action input.
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { W3ActionError, request } from '@w3-io/action-core'

const DEFAULT_API_URL = 'https://app.bitgo.com/api/v2'

/**
 * Wallet `type` values we know how to drive. v0 supports custodial
 * only — hot/cold wallets need a separate signing flow that lives
 * outside this action.
 */
const SUPPORTED_WALLET_TYPES = new Set(['custodial'])

/**
 * `multisigType` values that map to a real platform-API send path.
 * `blsdkg` (ETH2 validator) and any other value lands in unsupported.
 */
const SUPPORTED_MULTISIG_TYPES = new Set(['tss', 'onchain'])

/**
 * BitGo-specific error type. Extends W3ActionError so action-core's
 * handleError reports the structured code.
 */
export class BitGoError extends W3ActionError {
  constructor(code, message, { statusCode, details } = {}) {
    super(code, message, { statusCode, details })
    this.name = 'BitGoError'
  }
}

/**
 * Map BitGo's API error responses to typed BitGoError codes.
 *
 * BitGo returns JSON like `{ "error": "...", "name": "WalletLocked" }`
 * for application-level errors. We translate the well-known names
 * into stable codes downstream consumers can match on.
 */
function translateBitGoError(status, body) {
  const name = body && (body.name || body.code)
  const message = (body && body.error) || `BitGo API error (HTTP ${status})`

  if (status === 401 && /unlock/i.test(message)) {
    return new BitGoError('NEEDS_UNLOCK', message, { statusCode: status, details: body })
  }
  if (status === 401 || status === 403) {
    return new BitGoError('BITGO_UNAUTHORIZED', message, { statusCode: status, details: body })
  }
  if (name === 'WalletLocked' || name === 'NeedUnlock') {
    return new BitGoError('NEEDS_UNLOCK', message, { statusCode: status, details: body })
  }
  if (name === 'InsufficientFunds' || /insufficient/i.test(message)) {
    return new BitGoError('INSUFFICIENT_BALANCE', message, { statusCode: status, details: body })
  }
  if (name === 'PolicyViolation') {
    return new BitGoError('POLICY_VIOLATION', message, { statusCode: status, details: body })
  }
  return new BitGoError('BITGO_API_ERROR', message, { statusCode: status, details: body })
}

export class BitGoClient {
  /**
   * @param {object} opts
   * @param {string} opts.accessToken - BitGo access token (Bearer auth)
   * @param {string} [opts.enterpriseId] - Enterprise ID for create/list scoping
   * @param {string} [opts.apiUrl] - API base URL override
   * @param {number} [opts.timeout] - Per-request timeout in ms (default 30000)
   */
  constructor({ accessToken, enterpriseId, apiUrl = DEFAULT_API_URL, timeout = 30_000 } = {}) {
    if (!accessToken) {
      throw new BitGoError(
        'MISSING_ACCESS_TOKEN',
        'access-token is required for all BitGo commands',
      )
    }
    this.accessToken = accessToken
    this.enterpriseId = enterpriseId
    this.apiUrl = apiUrl.replace(/\/+$/, '')
    this.timeout = timeout

    // In-process cache for wallet metadata. Keyed by `${coin}:${walletId}`.
    // Lifetime is the action invocation only — we never persist across runs.
    this._walletCache = new Map()
  }

  /**
   * Internal: authenticated request to the BitGo API.
   */
  async _request(path, { method = 'GET', body, query } = {}) {
    let url = `${this.apiUrl}${path}`
    if (query) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') qs.append(k, String(v))
      }
      const qsString = qs.toString()
      if (qsString) url += `?${qsString}`
    }

    try {
      return await request(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body,
        timeout: this.timeout,
      })
    } catch (err) {
      // action-core throws W3ActionError with statusCode set and the
      // response body jammed into the message as `${status}: ${text}`.
      // Pull the body back out so we can translate the structured
      // BitGo error fields (name, reqId, etc.) instead of throwing
      // away everything except the HTTP status.
      if (err && typeof err === 'object' && 'statusCode' in err) {
        let parsed = err.details || err.body || null
        if (!parsed && typeof err.message === 'string') {
          const match = err.message.match(/^\d+:\s*(.*)$/s)
          const text = match ? match[1] : err.message
          try {
            parsed = text ? JSON.parse(text) : {}
          } catch {
            parsed = { error: text }
          }
        }
        throw translateBitGoError(err.statusCode, parsed || {})
      }
      throw err
    }
  }

  // ── Session ──────────────────────────────────────────────────────

  /**
   * Unlock the user session for sensitive operations.
   *
   * BitGo gates sends and policy mutations behind a recent unlock,
   * which requires a one-time code from the user's TOTP authenticator.
   * The test environment accepts the magic OTP `000000`. Production
   * accepts whatever code the bound authenticator app produces right
   * now (so workflows must inject it via a secret).
   *
   * Duration is in seconds. The default 600s (10 min) covers a
   * single workflow run with margin; the maximum BitGo allows is
   * around an hour.
   */
  async unlock({ otp, duration = 600 } = {}) {
    requireParam('otp', otp)
    return this._request('/user/unlock', {
      method: 'POST',
      body: { otp: String(otp), duration },
    })
  }

  // ── Wallet metadata ──────────────────────────────────────────────

  /**
   * Fetch wallet metadata. Cached per (coin, walletId) for the
   * duration of the action invocation.
   */
  async getWallet(coin, walletId) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)

    const cacheKey = `${coin}:${walletId}`
    const cached = this._walletCache.get(cacheKey)
    if (cached) return cached

    const wallet = await this._request(`/${coin}/wallet/${walletId}`)
    this._walletCache.set(cacheKey, wallet)
    return wallet
  }

  /**
   * Return both `type` (custodial/hot/cold) and `multisigType`
   * (tss/onchain/blsdkg) so the caller can dispatch on either axis.
   * Cached via getWallet.
   */
  async detectWalletType(coin, walletId) {
    const wallet = await this.getWallet(coin, walletId)
    return {
      type: wallet.type || 'custodial',
      multisigType: wallet.multisigType || 'onchain',
    }
  }

  // ── Tier 1: Wallet management ────────────────────────────────────

  async listWallets(coin, { enterpriseId, limit, prevId } = {}) {
    requireParam('coin', coin)
    return this._request(`/${coin}/wallet`, {
      query: {
        enterprise: enterpriseId || this.enterpriseId,
        limit,
        prevId,
      },
    })
  }

  async createWallet(coin, body, { enterpriseId } = {}) {
    requireParam('coin', coin)
    if (!body || typeof body !== 'object') {
      throw new BitGoError(
        'MISSING_BODY',
        'create-wallet requires a JSON body with wallet creation parameters',
      )
    }
    const payload = { ...body }
    if (!payload.enterprise) {
      payload.enterprise = enterpriseId || this.enterpriseId
    }
    return this._request(`/${coin}/wallet/generate`, {
      method: 'POST',
      body: payload,
    })
  }

  async shareWallet(coin, walletId, { user, permissions }) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('share-with-user', user)
    requireParam('share-permissions', permissions)
    return this._request(`/${coin}/wallet/${walletId}/share`, {
      method: 'POST',
      body: { user, permissions },
    })
  }

  async freezeWallet(coin, walletId, body = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    return this._request(`/${coin}/wallet/${walletId}/freeze`, {
      method: 'POST',
      body,
    })
  }

  async getBalance(coin, walletId) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    const wallet = await this.getWallet(coin, walletId)
    return {
      coin,
      walletId,
      balance: wallet.balanceString || String(wallet.balance ?? ''),
      confirmedBalance: wallet.confirmedBalanceString || String(wallet.confirmedBalance ?? ''),
      spendableBalance: wallet.spendableBalanceString || String(wallet.spendableBalance ?? ''),
    }
  }

  async listAddresses(coin, walletId, { limit, prevId } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    return this._request(`/${coin}/wallet/${walletId}/addresses`, {
      query: { limit, prevId },
    })
  }

  /**
   * Generate a new receive address on a wallet. Optional `label`
   * tags it for accounting; `chain` selects an address chain
   * (BitGo's internal address derivation, mostly relevant for UTXO
   * coins).
   */
  async createAddress(coin, walletId, { label, chain } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    const body = {}
    if (label) body.label = label
    if (chain !== undefined && chain !== null && chain !== '') body.chain = Number(chain)
    return this._request(`/${coin}/wallet/${walletId}/address`, {
      method: 'POST',
      body,
    })
  }

  /**
   * Compute the maximum amount the wallet can send in a single tx,
   * accounting for fees. Returns a `{ maximumSpendable, coin }` shape.
   */
  async maximumSpendable(coin, walletId, { feeRate } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    return this._request(`/${coin}/wallet/${walletId}/maximumSpendable`, {
      query: { feeRate },
    })
  }

  /**
   * Current network fee estimate for a coin. Returns the per-tier
   * fee rates BitGo recommends.
   */
  async feeEstimate(coin) {
    requireParam('coin', coin)
    return this._request(`/${coin}/tx/fee`)
  }

  // ── Tier 2: Sends (custodial only) ───────────────────────────────

  /**
   * Custodial send — dispatches on the wallet's `multisigType`.
   *
   * Both paths produce a `pendingApproval` that BitGo's signing
   * infrastructure resolves asynchronously. The caller can return
   * immediately with the approval ID (default), poll synchronously
   * via `wait-for-approval` (Layer 2), or auto-register a webhook
   * (Layer 3).
   *
   * Wallet-type validation is strict: any non-custodial wallet, or
   * a multisigType outside {tss, onchain}, fails fast with
   * UNSUPPORTED_WALLET_TYPE before we touch the API.
   *
   * Returns one of:
   *   - { status: 'pending-approval', pendingApprovalId, txRequestId?, correlationId, raw }
   *   - { status: 'sent', txHash, correlationId, raw }
   *   - { status: 'pending-approval', ..., webhookRegistration } when register-webhook-on-pending was set
   */
  async send(
    coin,
    walletId,
    {
      address,
      amount,
      comment,
      sequenceId,
      correlationId,
      registerWebhookOnPending,
      webhookUrl,
    } = {},
  ) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('address', address)
    requireParam('amount', amount)

    await this._validateCustodialWallet(coin, walletId)
    const { multisigType } = await this.detectWalletType(coin, walletId)

    const finalCorrelationId = correlationId || randomUUID()
    const finalComment = composeComment(comment, finalCorrelationId)

    let result
    let txRequestId = null

    if (multisigType === 'tss') {
      // TSS path: POST /wallet/:id/txrequests with the nested intent.
      // Note no coin prefix — BitGo identifies the coin from the
      // wallet ID itself for this endpoint.
      const intent = {
        intentType: 'payment',
        recipients: [
          {
            address: { address },
            amount: { value: String(amount), symbol: coin },
          },
        ],
      }
      if (finalComment) intent.comment = finalComment
      if (sequenceId) intent.sequenceId = sequenceId

      result = await this._request(`/wallet/${walletId}/txrequests`, {
        method: 'POST',
        body: { intent, apiVersion: 'full', preview: false },
      })
      txRequestId = result?.txRequestId || null
    } else {
      // Multi-sig path: POST /:coin/wallet/:id/tx/initiate with a
      // flat recipients array. Returns 200 with `{ error, pendingApproval }`.
      const body = {
        recipients: [{ address, amount: String(amount) }],
      }
      if (finalComment) body.comment = finalComment
      if (sequenceId) body.sequenceId = sequenceId

      result = await this._request(`/${coin}/wallet/${walletId}/tx/initiate`, {
        method: 'POST',
        body,
      })
    }

    return this._handleSendResult(coin, walletId, result, {
      correlationId: finalCorrelationId,
      txRequestId,
      registerWebhookOnPending,
      webhookUrl,
    })
  }

  /**
   * Get a single transaction by id (the BitGo internal tx record,
   * not the on-chain hash).
   */
  async getTransaction(coin, walletId, txId) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('tx-id', txId)
    return this._request(`/${coin}/wallet/${walletId}/tx/${txId}`)
  }

  async listTransactions(coin, walletId, { limit, prevId } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    return this._request(`/${coin}/wallet/${walletId}/tx`, {
      query: { limit, prevId },
    })
  }

  /**
   * Get a single transfer (BitGo's enriched view of a tx including
   * recipients, value movement, and confirmation state).
   */
  async getTransfer(coin, walletId, transferId) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('transfer-id', transferId)
    return this._request(`/${coin}/wallet/${walletId}/transfer/${transferId}`)
  }

  async listTransfers(coin, walletId, { limit, prevId } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    return this._request(`/${coin}/wallet/${walletId}/transfer`, {
      query: { limit, prevId },
    })
  }

  // ── TSS-specific tx requests ─────────────────────────────────────

  async getTxRequest(walletId, txRequestId) {
    requireParam('wallet-id', walletId)
    requireParam('tx-request-id', txRequestId)
    return this._request(`/wallet/${walletId}/txrequests/${txRequestId}`)
  }

  async listTxRequests(walletId) {
    requireParam('wallet-id', walletId)
    return this._request(`/wallet/${walletId}/txrequests`)
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /**
   * Throw a clean BitGoError if the wallet isn't custodial or its
   * signing model isn't supported. The detect call is cached so
   * this is essentially free for all but the first signing
   * operation against a given wallet in a single action invocation.
   */
  async _validateCustodialWallet(coin, walletId) {
    const { type, multisigType } = await this.detectWalletType(coin, walletId)
    if (!SUPPORTED_WALLET_TYPES.has(type)) {
      throw new BitGoError(
        'UNSUPPORTED_WALLET_TYPE',
        `Wallet type "${type}" is not supported. v0 supports custodial wallets only — for hot/self-managed wallets, use BitGo Express or a SDK-based action.`,
      )
    }
    if (!SUPPORTED_MULTISIG_TYPES.has(multisigType)) {
      throw new BitGoError(
        'UNSUPPORTED_MULTISIG_TYPE',
        `multisigType "${multisigType}" is not supported. Supported types: ${[...SUPPORTED_MULTISIG_TYPES].join(', ')}.`,
      )
    }
  }

  /**
   * Translate a BitGo send response (tx/initiate or txrequests)
   * into our standard pending-approval shape.
   *
   * The two underlying endpoints have very different bodies:
   *   - /tx/initiate returns `{ error, pendingApproval }` with HTTP 200
   *   - /txrequests returns `{ txRequestId, state, intent, ... }` and
   *     may also embed a `pendingApproval` if policy intercepts
   *
   * Both reduce to "tracked async work BitGo will complete" — we
   * surface a uniform pending-approval result so callers don't
   * have to know which underlying flow ran.
   */
  async _handleSendResult(
    coin,
    walletId,
    result,
    { correlationId, txRequestId, registerWebhookOnPending, webhookUrl } = {},
  ) {
    const pendingApprovalId =
      result?.pendingApproval?.id || result?.pendingApprovalId || result?.id || null

    const effectiveTxRequestId = txRequestId || result?.txRequestId || null

    // Multi-sig: tx/initiate returns 200 with the pendingApproval
    // embedded. TSS: txrequests returns the request envelope and
    // BitGo's signing infra picks it up.
    if (pendingApprovalId || effectiveTxRequestId) {
      const base = {
        status: 'pending-approval',
        pendingApprovalId,
        txRequestId: effectiveTxRequestId,
        correlationId,
        raw: result,
      }

      if (registerWebhookOnPending && webhookUrl) {
        try {
          await this.addWebhook(coin, walletId, {
            url: webhookUrl,
            type: 'pendingApproval',
          })
          base.webhookRegistration = {
            attempted: true,
            registered: true,
            url: webhookUrl,
          }
        } catch (err) {
          // Best-effort: webhook failures don't mask the pending result.
          base.webhookRegistration = {
            attempted: true,
            registered: false,
            error: err?.message || String(err),
          }
        }
      }

      return base
    }

    // Defensive: if neither id is present but the call returned a
    // success body, surface whatever tx hash we can find.
    const txHash =
      result?.txid || result?.txHash || result?.transfer?.txid || result?.transfer?.txHash || null
    return { status: 'sent', txHash, correlationId, raw: result }
  }

  // ── Tier 3: Policy and approval ──────────────────────────────────

  /**
   * List policy rules attached to a wallet. Returns a thin view
   * over getWallet's `admin.policy` payload.
   */
  async listPolicies(coin, walletId) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    const wallet = await this.getWallet(coin, walletId)
    return {
      coin,
      walletId,
      version: wallet?.admin?.policy?.version ?? null,
      latest: wallet?.admin?.policy?.latest ?? null,
      rules: wallet?.admin?.policy?.rules ?? [],
    }
  }

  async setPolicyRule(coin, walletId, body) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    if (!body || typeof body !== 'object') {
      throw new BitGoError(
        'MISSING_BODY',
        'set-policy-rule requires a JSON body with the policy rule definition',
      )
    }
    return this._request(`/${coin}/wallet/${walletId}/policy/rule`, {
      method: 'PUT',
      body,
    })
  }

  async removePolicyRule(coin, walletId, ruleId) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('policy-rule-id', ruleId)
    return this._request(`/${coin}/wallet/${walletId}/policy/rule`, {
      method: 'DELETE',
      body: { id: ruleId },
    })
  }

  async listPendingApprovals({ walletId, enterpriseId } = {}) {
    return this._request(`/pendingapprovals`, {
      query: {
        walletId,
        enterprise: enterpriseId || this.enterpriseId,
      },
    })
  }

  async getPendingApproval(pendingApprovalId) {
    requireParam('pending-approval-id', pendingApprovalId)
    return this._request(`/pendingapprovals/${pendingApprovalId}`)
  }

  async approvePending(pendingApprovalId, { otp } = {}) {
    requireParam('pending-approval-id', pendingApprovalId)
    const body = { state: 'approved' }
    if (otp) body.otp = String(otp)
    return this._request(`/pendingapprovals/${pendingApprovalId}`, {
      method: 'PUT',
      body,
    })
  }

  async rejectPending(pendingApprovalId) {
    requireParam('pending-approval-id', pendingApprovalId)
    return this._request(`/pendingapprovals/${pendingApprovalId}`, {
      method: 'PUT',
      body: { state: 'rejected' },
    })
  }

  // ── Layer 2: Synchronous wait-for-approval ───────────────────────

  /**
   * Block until a pending approval reaches a terminal state.
   *
   * Polling cadence: starts at 5s, exponentially backs off (×1.5)
   * to a 30s ceiling. The first poll happens immediately so
   * already-resolved approvals return on the first call.
   */
  async waitForApproval(pendingApprovalId, { timeout = 300, sleep = defaultSleep } = {}) {
    requireParam('pending-approval-id', pendingApprovalId)

    const maxTimeout = 3600
    const effectiveTimeout = Math.min(Math.max(Number(timeout) || 0, 1), maxTimeout)
    const deadline = Date.now() + effectiveTimeout * 1000

    let interval = 5000
    const maxInterval = 30000

    let lastBody = null
    while (Date.now() < deadline) {
      const approval = await this._request(`/pendingapprovals/${pendingApprovalId}`)
      lastBody = approval
      if (approval?.state === 'approved') {
        return {
          status: 'approved',
          pendingApprovalId,
          txHash: extractApprovalTxHash(approval),
          raw: approval,
        }
      }
      if (approval?.state === 'rejected') {
        return { status: 'rejected', pendingApprovalId, raw: approval }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(interval, remaining))
      interval = Math.min(interval * 1.5, maxInterval)
    }

    return { status: 'timeout', pendingApprovalId, raw: lastBody }
  }

  // ── Tier 4: Webhook registration ─────────────────────────────────

  async addWebhook(coin, walletId, { url, type = 'pendingApproval' } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('webhook-url', url)
    return this._request(`/${coin}/wallet/${walletId}/webhooks`, {
      method: 'POST',
      body: { url, type },
    })
  }

  async listWebhooks(coin, walletId) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    return this._request(`/${coin}/wallet/${walletId}/webhooks`)
  }

  async removeWebhook(coin, walletId, webhookId) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('webhook-id', webhookId)
    return this._request(`/${coin}/wallet/${walletId}/webhooks/${webhookId}`, {
      method: 'DELETE',
    })
  }
}

/**
 * Default sleep used by waitForApproval. Tests inject a fake sleep
 * to avoid waiting in real time.
 */
function defaultSleep(ms) {
  return delay(ms)
}

/**
 * Extract a tx hash from a resolved approval, if present. BitGo's
 * approval payload nests the transactions under different paths
 * depending on the approval type — cover the common shapes.
 */
function extractApprovalTxHash(approval) {
  return (
    approval?.transactions?.[0]?.txid ||
    approval?.transactions?.[0]?.txHash ||
    approval?.txid ||
    approval?.txHash ||
    null
  )
}

/**
 * Compose the BitGo `comment` field, embedding the correlation ID
 * with a stable marker prefix the future webhook receiver can grep
 * for. Preserves any user-supplied comment text.
 */
function composeComment(userComment, correlationId) {
  const marker = `[w3-corr:${correlationId}]`
  if (!userComment) return marker
  return `${userComment} ${marker}`
}

/**
 * Helper: throw a structured BitGoError when a required input is missing.
 */
function requireParam(name, value) {
  if (value === undefined || value === null || value === '') {
    throw new BitGoError(`MISSING_${name.toUpperCase().replace(/-/g, '_')}`, `${name} is required`)
  }
}
