/**
 * TODO: Rename this file to match your partner (e.g. cube3.js, stripe.js).
 *
 * This is your API client — the core logic of the action. It should:
 *
 *   1. Be independent of @actions/core (no imports from it here).
 *   2. Use `request` from @w3-io/action-core for HTTP — handles
 *      timeout, retry on 429/5xx, and structured errors.
 *   3. Throw W3ActionError on failures with machine-readable codes.
 *   4. Return clean, well-structured objects.
 *
 * Pattern:
 *   - Constructor takes config (apiKey, baseUrl)
 *   - One public method per command
 *   - Private helpers for formatting, parsing
 */

import { request, W3ActionError } from '@w3-io/action-core'

// TODO: Replace with your partner's API URL
const DEFAULT_BASE_URL = 'https://api.yourpartner.com'

// TODO: Rename this class (e.g. Cube3Client, StripeClient)
export class Client {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL } = {}) {
    // TODO: Remove this check if your API doesn't need auth
    if (!apiKey) {
      throw new W3ActionError('MISSING_API_KEY', 'API key is required')
    }
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /**
   * TODO: Replace with your first command.
   *
   * Example:
   *   async inspect(address) { ... }
   *   async getLatestPrices(ids) { ... }
   */
  async exampleCommand(input) {
    if (!input) {
      throw new W3ActionError('MISSING_INPUT', 'Input is required')
    }

    const { body } = await request(
      `${this.baseUrl}/v1/example/${encodeURIComponent(input)}`,
      {
        headers: {
          // TODO: Adjust auth header to match your partner's API.
          // Common patterns:
          //   'X-Api-Key': this.apiKey
          //   'Authorization': `Bearer ${this.apiKey}`
          'X-Api-Key': this.apiKey,
        },
      },
    )

    // TODO: Format the raw API response into a clean, stable structure.
    return body
  }
}
