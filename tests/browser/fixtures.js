const { test: base, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const FIXED_NOW = '2026-10-05T17:00:00.000Z'; // Monday 13:00 America/New_York
const SYNTHETIC_SCHEDULE = [
  { building: 'CKB', room: '217', days: [0], time_start: '14:30', time_end: '15:30', capacity: 30, course: 'TEST 101', title: 'Synthetic afternoon class', instructor: 'Test Instructor', term: 202690 },
  { building: 'CAB', room: '2020', days: [0], time_start: '09:00', time_end: '10:00', capacity: 60, course: 'TEST 102', title: 'Synthetic morning class', instructor: 'Test Instructor', term: 202690 },
  { building: 'FMH', room: '101', days: [0], time_start: '12:30', time_end: '14:00', capacity: 45, course: 'TEST 103', title: 'Synthetic occupied class', instructor: 'Test Instructor', term: 202690 },
  { building: 'CKB', room: 'G-08', days: [0], time_start: '16:00', time_end: '17:00', capacity: 20, course: 'TEST 104', title: 'Synthetic hyphenated room', instructor: 'Test Instructor', term: 202690 },
];

async function stopServer(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    let stdinError;
    const onStdinError = error => {
      // The peer may close stdin just before teardown. Do not suppress other
      // stream failures, and retain the listener until all child stdio closes.
      if (error.code !== 'EPIPE') stdinError ||= error;
    };
    child.stdin.on('error', onStdinError);
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    child.once('close', () => {
      clearTimeout(timer);
      child.stdin.off('error', onStdinError);
      if (stdinError) reject(stdinError);
      else resolve();
    });
    child.stdin.end(); // EOF also shuts the server down if this worker is killed.
  });
}

// Every test gets a distinct origin, process, visitor DB, upload folder, secrets,
// browser context and request context. Options accept JSON-serializable entries
// with time_start/time_end as HH:MM strings. An empty schedule is meaningful.
const test = base.extend({
  fixtureNow: [FIXED_NOW, { option: true }],
  fixtureSchedule: [SYNTHETIC_SCHEDULE, { option: true }],
  fixtureAuth: [{}, { option: true }],
  externalRequests: async ({}, use) => { await use([]); },

  server: async ({ fixtureNow, fixtureSchedule, fixtureAuth }, use, testInfo) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'room-finder-browser-'));
    const auth = {
      adminPassword: randomBytes(24).toString('hex'),
      uploadPassword: randomBytes(24).toString('hex'),
      ...fixtureAuth,
    };
    const configPath = path.join(directory, 'fixture.json');
    const ownerToken = randomBytes(24).toString('hex');
    let child;
    let output = '';
    try {
      await writeFile(path.join(directory, '.fixture-owner'), ownerToken, { mode: 0o600 });
      await writeFile(configPath, JSON.stringify({ now: fixtureNow, schedule: fixtureSchedule, auth, ownerToken }), { mode: 0o600 });
      const python = process.env.ROOM_FINDER_TEST_PYTHON || 'python';
      child = spawn(python, ['-u', path.join(__dirname, 'server.py'), configPath], {
        cwd: directory,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
        // Keep stdin open as a lifetime pipe. EOF survives even SIGKILL of
        // this worker, unlike JavaScript exit/finally cleanup handlers.
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', chunk => { output = (output + chunk.toString()).slice(-32_768); });
      }
      const url = await new Promise((resolve, reject) => {
        const lines = readline.createInterface({ input: child.stdout });
        const timer = setTimeout(() => finish(new Error('Fixture server startup timed out')), 15_000);
        const onError = error => finish(error);
        const onExit = (code, signal) => finish(new Error(`Fixture server exited (${code ?? signal})`));
        function finish(error, url) {
          clearTimeout(timer);
          lines.close();
          child.off('error', onError);
          child.off('exit', onExit);
          if (error) reject(new Error(`${error.message}\n${output}\nSet ROOM_FINDER_TEST_PYTHON to a Python with requirements-dev.txt installed.`));
          else resolve(url);
        }
        child.once('error', onError);
        child.once('exit', onExit);
        lines.on('line', line => {
          if (!line.startsWith('{')) return;
          try {
            const message = JSON.parse(line);
            if (message.ready && message.url) finish(null, message.url);
          } catch { /* Non-protocol app logging is captured above. */ }
        });
      });
      const ping = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(5_000) });
      if (!ping.ok || await ping.text() !== 'ok') throw new Error('Fixture server readiness check failed');
      await use({ url, directory, ...auth });
    } finally {
      try {
        await stopServer(child);
      } finally {
        await rm(directory, { recursive: true, force: true });
        if (testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach('fixture-server.log', { body: output, contentType: 'text/plain' });
        }
      }
    }
  },

  baseURL: async ({ server }, use) => { await use(server.url); },
  appURL: async ({ server }, use) => { await use(server.url); },

  // Same-origin requests exercise real Flask. All outside traffic, including
  // map tiles, fails deterministically. A test's page.route/context.route can
  // override this earlier route to supply controlled tiles or API failures.
  context: async ({ context, server, externalRequests }, use) => {
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (new URL(url).origin === server.url) return route.continue();
      externalRequests.push(url);
      await route.abort('blockedbyclient');
    });
    await use(context);
  },
  page: async ({ page, fixtureNow }, use) => {
    // Freeze Date without stopping polling, transitions or timeout timers.
    await page.clock.setFixedTime(new Date(fixtureNow));
    await use(page);
  },
});

module.exports = { test, expect, FIXED_NOW, SYNTHETIC_SCHEDULE, stopServer };
