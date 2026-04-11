/**
 * Integration tests against the live API.
 *
 * These are skipped by default and only run when credentials are available.
 * Two patterns for controlling when they run:
 *
 *   1. API key required (like Cube3):
 *      const API_KEY = process.env.YOUR_API_KEY
 *      const describeIf = (cond) => cond ? describe : describe.skip
 *      describeIf(API_KEY)('live API', () => { ... })
 *
 *   2. No auth needed (like Pyth):
 *      const SKIP = process.env.SKIP_LIVE_TESTS === '1'
 *      describeIf(!SKIP)('live API', () => { ... })
 *
 * Tips:
 *   - Use well-known, stable inputs (e.g. Vitalik's address, BTC/USD)
 *   - Assert structure, not exact values (prices change!)
 *   - Keep tests fast — one or two API calls, not exhaustive
 *
 * TODO: Uncomment and adapt one of the patterns below.
 */

// import { Client } from '../src/client.js'

// --- Pattern 1: API key required ---
//
// const API_KEY = process.env.YOUR_PARTNER_API_KEY
// const describeIf = (cond) => (cond ? describe : describe.skip)
//
// describeIf(API_KEY)('Integration (live API)', () => {
//   let client
//   beforeAll(() => {
//     client = new Client({ apiKey: API_KEY })
//   })
//
//   test('returns valid data for known input', async () => {
//     const result = await client.exampleCommand('known-input')
//     expect(result).toBeDefined()
//   })
// })

// --- Pattern 2: No auth needed ---
//
// const SKIP = process.env.SKIP_LIVE_TESTS === '1'
// const describeIf = (cond) => (cond ? describe : describe.skip)
//
// describeIf(!SKIP)('Integration (live API)', () => {
//   const client = new Client()
//
//   test('returns valid data', async () => {
//     const result = await client.exampleCommand('known-input')
//     expect(result).toBeDefined()
//   })
// })

// Placeholder to keep Jest happy when everything is commented out
describe('integration tests', () => {
  test.skip('TODO: implement live API tests', () => {})
})
