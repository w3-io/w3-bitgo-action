/**
 * BitGo API client.
 *
 * Wraps the BitGo Platform REST API at https://app.bitgo.com/api/v2
 * (or https://app.bitgo-test.com/api/v2 for the test environment).
 *
 * Auth model: long-lived access token sent as `Authorization: Bearer ...`.
 * Wallet signing operations additionally require a `walletPassphrase`
 * to decrypt the user keychain — this is the BitGo-specific gotcha.
 *
 * Wallet type detection: BitGo wallets are either TSS (MPC) or
 * on-chain multi-sig. The two have slightly different signing
 * request shapes. Rather than asking the caller, we query
 * `/:coin/wallet/:id` once at the start of any signing operation
 * and dispatch on the returned `multisigType`. The cost is one
 * extra HTTP round-trip (~50ms) per send; the benefit is the
 * caller never needs to know which model their wallet uses.
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { W3ActionError, request } from '@w3-io/action-core'

const DEFAULT_API_URL = 'https://app.bitgo.com/api/v2'

/**
 * Wallet types we know how to sign for. Cold wallets and BLS DKG
 * (ETH2 validator) wallets need separate signing flows that v0
 * doesn't support — we throw a clear error early rather than let
 * the API reject the request with a confusing message.
 */
const SIGNABLE_WALLET_TYPES = new Set(['tss', 'onchain'])

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
  const name = body && (body.name || body.error || body.code)
  const message = (body && body.error) || `BitGo API error (HTTP ${status})`

  if (status === 401 || status === 403) {
    return new BitGoError('BITGO_UNAUTHORIZED', message, { statusCode: status, details: body })
  }
  if (name === 'WalletLocked' || name === 'NeedUnlock') {
    return new BitGoError('WALLET_LOCKED', message, { statusCode: status, details: body })
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
   * @param {string} [opts.walletPassphrase] - Passphrase for signing operations
   * @param {string} [opts.apiUrl] - API base URL override
   * @param {number} [opts.timeout] - Per-request timeout in ms (default 30000)
   */
  constructor({
    accessToken,
    enterpriseId,
    walletPassphrase,
    apiUrl = DEFAULT_API_URL,
    timeout = 30_000,
  } = {}) {
    if (!accessToken) {
      throw new BitGoError(
        'MISSING_ACCESS_TOKEN',
        'access-token is required for all BitGo commands',
      )
    }
    this.accessToken = accessToken
    this.enterpriseId = enterpriseId
    this.walletPassphrase = walletPassphrase
    this.apiUrl = apiUrl.replace(/\/+$/, '')
    this.timeout = timeout

    // In-process cache for wallet metadata. Keyed by `${coin}:${walletId}`.
    // Lifetime is the action invocation only — we never persist across runs.
    // Used by detectWalletType() to avoid re-fetching the same wallet
    // when a single command (e.g. wait-for-approval) needs the metadata twice.
    this._walletCache = new Map()
  }

  /**
   * Internal: authenticated request to the BitGo API.
   *
   * BitGo returns 2xx with JSON body on success and 4xx/5xx with
   * `{ error, name }` on failure. We translate non-2xx into typed
   * BitGoError instances via translateBitGoError so command handlers
   * can match on stable codes.
   *
   * @param {string} path - Path under apiUrl, with leading slash
   * @param {object} [options]
   * @param {string} [options.method] - HTTP method (default GET)
   * @param {object} [options.body] - JSON body (will be serialized)
   * @param {object} [options.query] - Query parameters
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
      // action-core's request throws on non-2xx with statusCode and details.
      // Translate into a BitGoError if it's a structured response.
      if (err && typeof err === 'object' && 'statusCode' in err) {
        throw translateBitGoError(err.statusCode, err.details || err.body || {})
      }
      throw err
    }
  }

  /**
   * Fetch wallet metadata.
   *
   * Used directly for get-wallet, and indirectly by detectWalletType
   * for any signing operation. Cached per (coin, walletId) for the
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
   * Detect wallet signing model.
   *
   * Returns one of:
   *   - 'tss'      → BitGo MPC TSS wallet
   *   - 'onchain'  → on-chain multi-sig wallet
   *   - 'blsdkg'   → ETH2 validator (BLS signing — different signing path)
   *
   * Falls back to 'onchain' if multisigType is missing (older wallets).
   *
   * Performance: one HTTP call the first time we see a (coin, walletId)
   * pair, cached after that. The wait-for-approval polling loop will
   * call this once and reuse the cached value.
   */
  async detectWalletType(coin, walletId) {
    const wallet = await this.getWallet(coin, walletId)
    return wallet.multisigType || 'onchain'
  }

  // ── Wallet management ────────────────────────────────────────────

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

  // ── Tier 2: Transactions and signing ─────────────────────────────

  /**
   * Build an unsigned transaction. Selects UTXOs (UTXO coins) or
   * fetches the next nonce (account coins) as appropriate. The
   * returned object includes a `txHex` or `tx` plus fee information.
   * No signing happens here — see sendTransaction for the build +
   * sign + broadcast path.
   */
  async buildTransaction(coin, walletId, { address, amount, feeRate } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('address', address)
    requireParam('amount', amount)

    const body = {
      recipients: [{ address, amount: String(amount) }],
    }
    if (feeRate !== undefined && feeRate !== null && feeRate !== '') {
      body.feeRate = String(feeRate)
    }

    return this._request(`/${coin}/wallet/${walletId}/tx/build`, {
      method: 'POST',
      body,
    })
  }

  /**
   * Build, sign, and broadcast a transaction.
   *
   * Auto-detects wallet type (TSS vs on-chain multi-sig) at runtime
   * and validates that v0 supports it. Both supported types use the
   * same `sendcoins` endpoint — BitGo's server handles the signing
   * model selection. The detect call exists to fail fast on cold
   * wallets and BLS DKG wallets, which need different signing paths
   * not yet supported.
   *
   * If BitGo returns a pendingApproval response (the policy engine
   * intercepted the tx), we translate it into our standard
   * `{ status: "pending-approval", pendingApprovalId, correlationId }`
   * shape and optionally auto-register a webhook for Layer 3
   * async continuation.
   */
  async sendTransaction(
    coin,
    walletId,
    {
      address,
      amount,
      walletPassphrase,
      feeRate,
      comment,
      correlationId,
      registerWebhookOnPending,
      webhookUrl,
    } = {},
  ) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('address', address)
    requireParam('amount', amount)
    requireParam('wallet-passphrase', walletPassphrase || this.walletPassphrase)

    await this._validateWalletForSigning(coin, walletId)

    const finalCorrelationId = correlationId || randomUUID()
    const body = {
      address,
      amount: String(amount),
      walletPassphrase: walletPassphrase || this.walletPassphrase,
      // Embed correlation ID in the comment so a future webhook can
      // extract it. Use a stable marker prefix so the webhook
      // receiver knows where to look.
      comment: composeComment(comment, finalCorrelationId),
    }
    if (feeRate !== undefined && feeRate !== null && feeRate !== '') {
      body.feeRate = String(feeRate)
    }

    const result = await this._request(`/${coin}/wallet/${walletId}/sendcoins`, {
      method: 'POST',
      body,
    })

    return this._handleSendResult(coin, walletId, result, {
      correlationId: finalCorrelationId,
      registerWebhookOnPending,
      webhookUrl,
    })
  }

  /**
   * Batch send to multiple recipients in a single transaction. The
   * caller passes the recipients array (and any other sendmany
   * fields) via the `body` JSON input.
   */
  async sendMany(coin, walletId, { walletPassphrase, body, correlationId } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('wallet-passphrase', walletPassphrase || this.walletPassphrase)
    if (!body || typeof body !== 'object') {
      throw new BitGoError('MISSING_BODY', 'send-many requires a JSON body with recipients')
    }
    if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
      throw new BitGoError(
        'INVALID_BODY',
        'send-many body must include a non-empty recipients array',
      )
    }

    await this._validateWalletForSigning(coin, walletId)

    const finalCorrelationId = correlationId || randomUUID()
    const payload = {
      ...body,
      walletPassphrase: walletPassphrase || this.walletPassphrase,
      comment: composeComment(body.comment, finalCorrelationId),
    }

    const result = await this._request(`/${coin}/wallet/${walletId}/sendmany`, {
      method: 'POST',
      body: payload,
    })

    return this._handleSendResult(coin, walletId, result, {
      correlationId: finalCorrelationId,
    })
  }

  /**
   * Speed up a stuck transaction. Uses RBF on Bitcoin and similar
   * acceleration paths on EVM coins (replacement tx with higher
   * gas/fee). The caller supplies the new fee rate.
   */
  async accelerateTransaction(coin, walletId, txId, { walletPassphrase, feeRate } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('tx-id', txId)
    requireParam('wallet-passphrase', walletPassphrase || this.walletPassphrase)

    await this._validateWalletForSigning(coin, walletId)

    const body = {
      walletPassphrase: walletPassphrase || this.walletPassphrase,
      cpfpTxIds: [txId],
    }
    if (feeRate !== undefined && feeRate !== null && feeRate !== '') {
      body.feeRate = String(feeRate)
    }

    return this._request(`/${coin}/wallet/${walletId}/accelerateTransaction`, {
      method: 'POST',
      body,
    })
  }

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
   * Consolidate UTXOs (UTXO coins only). BitGo will return a
   * helpful error if called on an account-based coin like ETH.
   */
  async consolidate(coin, walletId, { walletPassphrase, body } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('wallet-passphrase', walletPassphrase || this.walletPassphrase)

    await this._validateWalletForSigning(coin, walletId)

    const payload = {
      ...(body || {}),
      walletPassphrase: walletPassphrase || this.walletPassphrase,
    }

    return this._request(`/${coin}/wallet/${walletId}/consolidateUnspents`, {
      method: 'POST',
      body: payload,
    })
  }

  async sweep(coin, walletId, { address, walletPassphrase } = {}) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('address', address)
    requireParam('wallet-passphrase', walletPassphrase || this.walletPassphrase)

    await this._validateWalletForSigning(coin, walletId)

    return this._request(`/${coin}/wallet/${walletId}/sweep`, {
      method: 'POST',
      body: {
        address,
        walletPassphrase: walletPassphrase || this.walletPassphrase,
      },
    })
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /**
   * Throw a clean BitGoError if the wallet's signing model isn't
   * something v0 supports. The detect call is cached so this is
   * essentially free for all but the first signing operation
   * against a given wallet in a single action invocation.
   */
  async _validateWalletForSigning(coin, walletId) {
    const type = await this.detectWalletType(coin, walletId)
    if (!SIGNABLE_WALLET_TYPES.has(type)) {
      throw new BitGoError(
        'UNSUPPORTED_WALLET_TYPE',
        `Wallet type "${type}" is not supported for signing in v0. Supported types: ${[...SIGNABLE_WALLET_TYPES].join(', ')}.`,
      )
    }
    return type
  }

  /**
   * Translate a BitGo send response into our standard shape.
   *
   * On success, BitGo returns a transaction object with `txid` (or
   * `txHash` on EVM coins). On policy hold, BitGo returns a
   * `pendingApproval` object — we surface that explicitly with
   * `status: "pending-approval"` and the correlation ID so the
   * workflow author can react via wait-for-approval (Layer 2) or
   * wait for a webhook to fire a follow-up workflow (Layer 3).
   */
  async _handleSendResult(
    coin,
    walletId,
    result,
    { correlationId, registerWebhookOnPending, webhookUrl } = {},
  ) {
    const pendingApproval = result?.pendingApproval || result?.status === 'pendingApproval'

    if (pendingApproval) {
      // BitGo can return either { pendingApproval: { id, ... } } or
      // a flatter shape with status==="pendingApproval". Cover both.
      const pendingApprovalId =
        result?.pendingApproval?.id || result?.pendingApprovalId || result?.id || null

      // Optionally register a webhook so the future async receiver
      // can fire a follow-up workflow when the approval resolves.
      // Best-effort: a webhook registration failure does NOT mask
      // the pending-approval result the caller cares about.
      if (registerWebhookOnPending && webhookUrl) {
        try {
          await this.addWebhook(coin, walletId, {
            url: webhookUrl,
            type: 'pendingApproval',
          })
        } catch (err) {
          // Surface the webhook failure as a side note in the result,
          // but do not throw — the workflow already needs to handle
          // the pending-approval state and the webhook is bonus.
          return {
            status: 'pending-approval',
            pendingApprovalId,
            correlationId,
            webhookRegistration: {
              attempted: true,
              registered: false,
              error: err?.message || String(err),
            },
            raw: result,
          }
        }
        return {
          status: 'pending-approval',
          pendingApprovalId,
          correlationId,
          webhookRegistration: {
            attempted: true,
            registered: true,
            url: webhookUrl,
          },
          raw: result,
        }
      }

      return {
        status: 'pending-approval',
        pendingApprovalId,
        correlationId,
        raw: result,
      }
    }

    // Sent: extract the canonical tx hash and surface as a stable shape.
    const txHash =
      result?.txid || result?.txHash || result?.transfer?.txid || result?.transfer?.txHash || null

    return {
      status: 'sent',
      txHash,
      correlationId,
      raw: result,
    }
  }

  // ── Tier 3: Policy and approval ──────────────────────────────────

  /**
   * List policy rules attached to a wallet.
   *
   * BitGo returns the policy as part of the wallet object, so this
   * is a thin convenience over getWallet that surfaces just the
   * policy document for callers who only care about the rules.
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

  /**
   * Add or update a policy rule (spending limit, velocity,
   * allowlist, etc.). The full rule definition is passed via the
   * body input — BitGo's policy schema is rich and per-rule-type,
   * so we don't try to model it in TypeScript-style helpers.
   */
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

  /**
   * Remove a policy rule by ID.
   */
  async removePolicyRule(coin, walletId, ruleId) {
    requireParam('coin', coin)
    requireParam('wallet-id', walletId)
    requireParam('policy-rule-id', ruleId)
    return this._request(`/${coin}/wallet/${walletId}/policy/rule`, {
      method: 'DELETE',
      body: { id: ruleId },
    })
  }

  /**
   * List pending approvals scoped to a wallet, an enterprise, or
   * (if neither is supplied) the constructor's default enterprise.
   */
  async listPendingApprovals({ walletId, enterpriseId } = {}) {
    return this._request(`/pendingapprovals`, {
      query: {
        walletId,
        enterprise: enterpriseId || this.enterpriseId,
      },
    })
  }

  /**
   * Approve a pending approval. If the approval is for a
   * tx-signing operation, BitGo also needs the wallet passphrase
   * to actually sign the transaction. Reads-only approvals
   * (e.g. policy changes) don't need the passphrase.
   */
  async approvePending(pendingApprovalId, { walletPassphrase } = {}) {
    requireParam('pending-approval-id', pendingApprovalId)
    const body = { state: 'approved' }
    const passphrase = walletPassphrase || this.walletPassphrase
    if (passphrase) body.walletPassphrase = passphrase
    return this._request(`/pendingapprovals/${pendingApprovalId}`, {
      method: 'PUT',
      body,
    })
  }

  /**
   * Reject a pending approval.
   */
  async rejectPending(pendingApprovalId) {
    requireParam('pending-approval-id', pendingApprovalId)
    return this._request(`/pendingapprovals/${pendingApprovalId}`, {
      method: 'PUT',
      body: { state: 'rejected' },
    })
  }

  // ── Layer 2: Synchronous wait-for-approval ───────────────────────

  /**
   * Block until a pending approval transitions to a terminal state
   * (approved or rejected) or until the timeout elapses.
   *
   * Polling cadence: starts at 5s, exponentially backs off (×1.5)
   * to a 30s ceiling. The first poll happens immediately so
   * already-resolved approvals return on the first call.
   *
   * Returns:
   *   - { status: "approved",  raw, txHash? } when state === "approved"
   *   - { status: "rejected",  raw }          when state === "rejected"
   *   - { status: "timeout",   raw }          when timeout exceeded
   *
   * The txHash is extracted only if the underlying approval was a
   * tx-signing operation that has a transactions[0] entry once
   * approved.
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
      // Sleep, but never beyond the deadline.
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(interval, remaining))
      interval = Math.min(interval * 1.5, maxInterval)
    }

    return { status: 'timeout', pendingApprovalId, raw: lastBody }
  }

  // ── Tier 4: Webhook registration ─────────────────────────────────

  /**
   * Register a webhook against a wallet for transfer or
   * pendingApproval events. Sent as POST /:coin/wallet/:id/webhooks.
   */
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
 * Keeps command handlers free of repeated `if (!x) throw ...` lines.
 */
function requireParam(name, value) {
  if (value === undefined || value === null || value === '') {
    throw new BitGoError(`MISSING_${name.toUpperCase().replace(/-/g, '_')}`, `${name} is required`)
  }
}
