/**
 * Mock for @actions/core — used in tests to simulate the GitHub Actions
 * runtime without actually running inside Actions.
 *
 * Usage in tests:
 *
 *   const mockCore = await import('../__fixtures__/core.js')
 *   jest.unstable_mockModule('@actions/core', () => mockCore)
 *
 *   // Before each test:
 *   mockCore.reset()
 *   mockCore.setInputs({ command: 'inspect', 'api-key': 'test' })
 *
 *   // After running your action:
 *   const result = JSON.parse(mockCore.getOutputs().result)
 *   expect(mockCore.getErrors()).toHaveLength(0)
 *
 * This mock is shared across all W3 actions. Don't modify it for
 * partner-specific behavior — put that in your test files instead.
 */

const inputs = {}
const outputs = {}
const errors = []
const summaryLines = []

export function setInputs(map) {
  Object.keys(inputs).forEach((k) => delete inputs[k])
  Object.assign(inputs, map)
}

export function getInput(name, options) {
  const val = inputs[name] || ''
  if (options?.required && !val) {
    throw new Error(`Input required and not supplied: ${name}`)
  }
  return val
}

export function setOutput(name, value) {
  outputs[name] = value
}

export function setFailed(message) {
  errors.push(message)
}

export function info() {}
export function warning() {}

export const summary = {
  _buffer: '',
  addHeading(text) {
    this._buffer += `# ${text}\n`
    return this
  },
  addRaw(text) {
    this._buffer += text
    return this
  },
  addTable() {
    return this
  },
  addCodeBlock(code, lang) {
    this._buffer += `\`\`\`${lang || ''}\n${code}\n\`\`\`\n`
    return this
  },
  write() {
    summaryLines.push(this._buffer)
    this._buffer = ''
    return this
  },
}

export function getOutputs() {
  return { ...outputs }
}

export function getErrors() {
  return [...errors]
}

export function reset() {
  Object.keys(inputs).forEach((k) => delete inputs[k])
  Object.keys(outputs).forEach((k) => delete outputs[k])
  errors.length = 0
  summaryLines.length = 0
  summary._buffer = ''
}
