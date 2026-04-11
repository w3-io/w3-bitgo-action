import { createCommandRouter, handleError, setJsonOutput } from '@w3-io/action-core'
import * as core from '@actions/core'
// TODO: Import your client
import { Client } from './client.js'

/**
 * W3 Action Template
 *
 * Each command is an async function that reads inputs, calls the client,
 * and returns a result. The router handles dispatch and error reporting.
 *
 * To add a command:
 *   1. Write a handler function below
 *   2. Add it to the commands map
 */

// TODO: Initialize your client
function getClient() {
  return new Client({
    apiKey: core.getInput('api-key', { required: true }),
    baseUrl: core.getInput('api-url') || undefined,
  })
}

const router = createCommandRouter({
  // TODO: Replace with your commands
  'example-command': async () => {
    const client = getClient()
    const input = core.getInput('input', { required: true })
    const result = await client.exampleCommand(input)
    setJsonOutput('result', result)
  },
})

router()
