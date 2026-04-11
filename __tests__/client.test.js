/**
 * Client unit tests.
 *
 * These test your API client in isolation by mocking fetch().
 * No GitHub Actions runtime, no real API calls.
 *
 * Pattern:
 *   - mockOk(data) simulates a successful API response
 *   - mockError(status, body) simulates an error
 *   - Test the happy path, error paths, and edge cases
 *   - Use fixtures from __fixtures__/ for realistic response data
 *
 * TODO: Update imports to match your renamed client and error class.
 */

import { jest } from '@jest/globals'
import { readFileSync } from 'fs'
// TODO: Update these imports
import { Client, ClientError } from '../src/client.js'

const fixtureResponse = JSON.parse(
  readFileSync(new URL('../__fixtures__/api-response.json', import.meta.url)),
)

const mockFetch = jest.fn()
global.fetch = mockFetch

function mockOk(data) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  })
}

function mockError(status, body) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => body,
  })
}

// TODO: Update describe block and tests for your client
describe('Client', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  test('constructor requires api key', () => {
    expect(() => new Client({})).toThrow('API key is required')
  })

  test('constructor strips trailing slash from base URL', () => {
    const client = new Client({ apiKey: 'test', baseUrl: 'https://example.com/' })
    expect(client.baseUrl).toBe('https://example.com')
  })

  describe('exampleCommand', () => {
    const client = new Client({ apiKey: 'test-key' })

    test('calls the correct endpoint', async () => {
      mockOk(fixtureResponse)

      await client.exampleCommand('test-input')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.yourpartner.com/v1/example/test-input',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'X-Api-Key': 'test-key',
          }),
        }),
      )
    })

    test('requires input', async () => {
      await expect(client.exampleCommand('')).rejects.toThrow('Input is required')
    })

    test('throws on API error', async () => {
      mockError(500, 'Internal Server Error')

      try {
        await client.exampleCommand('test')
      } catch (e) {
        expect(e).toBeInstanceOf(ClientError)
        expect(e.code).toBe('API_ERROR')
        expect(e.status).toBe(500)
      }
    })

    test('throws on invalid JSON response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'not json',
      })

      try {
        await client.exampleCommand('test')
      } catch (e) {
        expect(e).toBeInstanceOf(ClientError)
        expect(e.code).toBe('PARSE_ERROR')
      }
    })
  })
})
