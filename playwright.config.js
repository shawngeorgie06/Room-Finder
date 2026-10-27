const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');

// Local Brave is opt-in; CI always installs Playwright's matching Chromium.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
// One run root owns all output; parallel invocations must use distinct roots.
const outputRoot = path.resolve(process.env.PLAYWRIGHT_OUTPUT_DIR || path.join(__dirname, 'test-results'));

module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: path.join(outputRoot, 'artifacts'),
  reporter: [
    [process.env.CI ? 'line' : 'list'],
    ['html', { outputFolder: path.join(outputRoot, 'report'), open: 'never' }],
    ['json', { outputFile: path.join(outputRoot, 'results.json') }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    timezoneId: 'America/New_York',
    serviceWorkers: 'block',
    launchOptions: executablePath ? { executablePath } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
