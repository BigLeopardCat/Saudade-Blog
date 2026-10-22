import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from '@playwright/test'

const run = promisify(execFile)

// Transitional CI entry: reuse the real-route assertions until the manual driver
// is migrated to native Playwright fixtures; do not maintain a duplicate suite.
test('river route: WebGL water, dialogs, wish failures and motion lifecycle', async ({ browserName }, info) => {
  test.skip(browserName !== 'chromium', 'This bridge verifies Chromium WebGL')
  test.setTimeout(360_000)
  try {
    const result = await run(process.execPath, ['tests/riverboard.browser.mjs'], {
      cwd: process.cwd(),
      timeout: 355_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        RIVER_TEST_URL: 'http://127.0.0.1:5174/guestbook',
        RIVER_SCREENSHOTS: info.outputPath('riverboard'),
        RIVER_RECORD: '0',
        RIVER_RECORD_ONLY: '0',
      },
    })
    await info.attach('river-run.log', { body: result.stdout + result.stderr, contentType: 'text/plain' })
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    const output = `${failure.stdout || ''}\n${failure.stderr || ''}`
    await info.attach('river-failure.log', { body: output, contentType: 'text/plain' })
    throw new Error(`River route regression failed: ${failure.message}\n${output.slice(-12_000)}`, { cause: error })
  }
})
