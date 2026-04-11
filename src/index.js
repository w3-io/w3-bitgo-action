import { run } from './main.js'

// Suppress stray unhandled rejections from @actions/core internals.
// Without this, Node.js >= 15 exits with code 1 on any unhandled rejection
// even when the action's main flow handled the error correctly.
process.on('unhandledRejection', () => {})

run()
