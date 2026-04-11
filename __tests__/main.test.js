/**
 * Main integration tests.
 *
 * These test the full action — command routing, input reading, output
 * formatting, and error reporting — with @actions/core mocked.
 *
 * Pattern:
 *   - Mock both fetch and @actions/core
 *   - Use setInputs() to simulate workflow inputs
 *   - Call run() and check getOutputs() / getErrors()
 *   - Test each command, unknown commands, and missing inputs
 *
 * TODO: Update for your commands and inputs.
 */

import { jest } from '@jest/globals'
import { readFileSync } from 'fs'

const fixtureResponse = JSON.parse(
  readFileSync(new URL('../__fixtures__/api-response.json', import.meta.url)),
)

const mockFetch = jest.fn()
global.fetch = mockFetch

const mockCore = await import('../__fixtures__/core.js')
jest.unstable_mockModule('@actions/core', () => mockCore)

const { run } = await import('../src/main.js')

function mockOk(data) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  })
}

describe('run', () => {
  beforeEach(() => {
    mockCore.reset()
    mockFetch.mockReset()
  })

  // TODO: Replace with a test for your first command
  test('example-command returns result', async () => {
    mockCore.setInputs({
      command: 'example-command',
      'api-key': 'test-key',
      input: 'test-value',
    })
    mockOk(fixtureResponse)

    await run()

    const outputs = mockCore.getOutputs()
    expect(outputs.result).toBeDefined()
    expect(mockCore.getErrors()).toHaveLength(0)
  })

  test('unknown command fails with available commands listed', async () => {
    mockCore.setInputs({
      command: 'nonexistent',
      'api-key': 'test-key',
    })

    await run()

    const errors = mockCore.getErrors()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Unknown command')
    expect(errors[0]).toContain('nonexistent')
  })

  test('missing api-key fails', async () => {
    mockCore.setInputs({
      command: 'example-command',
      input: 'test',
    })

    await run()

    const errors = mockCore.getErrors()
    expect(errors).toHaveLength(1)
  })

  test('API error is reported as failure', async () => {
    mockCore.setInputs({
      command: 'example-command',
      'api-key': 'test-key',
      input: 'test',
    })
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })

    await run()

    const errors = mockCore.getErrors()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('API_ERROR')
  })
})
