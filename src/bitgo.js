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

import { W3ActionError, request } from '@w3-io/action-core'

const DEFAULT_API_URL = 'https://app.bitgo.com/api/v2'

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

  // Stub methods for tiers 2-4 land in subsequent commits.
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
