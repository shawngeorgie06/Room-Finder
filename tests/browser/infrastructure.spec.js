const { test, expect, FIXED_NOW, SYNTHETIC_SCHEDULE, stopServer } = require('./fixtures');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const { mkdtemp, writeFile, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

async function assertScriptOrder(page) {
  const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => new URL(node.src).pathname));
  expect(scripts.filter(src => src === '/static/app.js')).toHaveLength(1);
  expect(scripts.filter(src => src === '/static/reliability.js')).toHaveLength(1);
  expect(scripts.indexOf('/static/reliability.js')).toBeLessThan(scripts.indexOf('/static/app.js'));
}

async function scheduleFiles(directory) {
  const names = (await readdir(directory)).filter(name => /^(uploaded_schedule|Course_Schedule_|schedule_default).*\.(csv|xlsx)$/.test(name)).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [
    name, createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex'),
  ])));
}

test('serves the actual shell and bundled JavaScript with a deterministic campus clock', async ({ page, appURL }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(appURL);
  await expect(page).toHaveTitle(/NJIT/i);
  expect(errors, 'shell scripts must initialize without an exception').toEqual([]);
  await assertScriptOrder(page);
  await expect(page.locator('#buildings-grid')).not.toBeEmpty();
  expect(await page.evaluate(() => new Date().toISOString())).toBe(FIXED_NOW);
  expect(errors).toEqual([]);
});

test('real APIs use only the synthetic schedule at Monday 13:00 Eastern', async ({ request }) => {
  const response = await request.get('/api/rooms/all');
  expect(response.ok()).toBeTruthy();
  const rooms = await response.json();
  expect(rooms.map(({ building, room }) => `${building} ${room}`).sort()).toEqual([
    'CAB 2020', 'CKB 217', 'CKB G-08', 'FMH 101',
  ]);
  expect(rooms.find(room => room.building === 'CKB' && room.room === '217')).toMatchObject({
    empty: true, minutes_until_next: 90, capacity: 30,
  });
  expect(rooms.find(room => room.building === 'FMH')).toMatchObject({ empty: false });
  const detail = await (await request.get('/api/room/schedule?building=FMH&room=101')).json();
  expect(detail).toMatchObject({ occupied_now: true, weekday: 'Monday', now_min: 780 });
});

test('visitor storage starts empty, records only disposable visits, and requires test auth', async ({ request, server }) => {
  const unauthorized = await request.get('/admin/visits');
  expect(unauthorized.status()).toBe(401);
  const headers = { Authorization: `Basic ${Buffer.from(`test:${server.adminPassword}`).toString('base64')}` };
  const before = await request.get('/admin/visits', { headers });
  expect(before.status()).toBe(200);
  expect(before.headers()['cache-control']).toContain('no-store');
  expect(await before.text()).not.toContain('synthetic-browser-agent');
  await request.get('/', { headers: { 'User-Agent': 'synthetic-browser-agent' } });
  const after = await request.get('/admin/visits', { headers });
  expect(await after.text()).toContain('synthetic-browser-agent');
  const database = path.join(server.directory, 'visits.sqlite3');
  expect((await readFile(database)).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  const storedAgent = execFileSync(process.env.ROOM_FINDER_TEST_PYTHON || 'python', ['-c',
    'import sqlite3, sys; db = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True); print(db.execute("SELECT user_agent FROM visits").fetchone()[0])',
    database,
  ], { encoding: 'utf8' }).trim();
  expect(storedAgent).toBe('synthetic-browser-agent');
});

test('starts each browser context with empty app storage and blocks outside network', async ({ page, appURL, externalRequests }) => {
  await page.goto(appURL);
  expect(await page.evaluate(() => localStorage.getItem('fixture-isolation'))).toBeNull();
  await page.evaluate(() => localStorage.setItem('fixture-isolation', 'only-this-test'));
  const result = await page.evaluate(async () => {
    try { await fetch('https://example.invalid/fixture-no-network'); return 'unexpected network'; }
    catch { return 'blocked'; }
  });
  expect(result).toBe('blocked');
  expect(externalRequests).toContain('https://example.invalid/fixture-no-network');
});

test('allows deterministic API failure injection without replacing product code', async ({ page, appURL }) => {
  await page.route('**/api/rooms/all*', route => route.fulfill({ status: 503, json: { error: 'synthetic outage' } }));
  await page.goto(appURL);
  expect(await page.evaluate(async () => (await fetch('/api/rooms/all')).status)).toBe(503);
});

test('valid uploads mutate only the disposable schedule directory', async ({ request, server }) => {
  const before = await scheduleFiles(ROOT);
  const csv = 'Term,Course,Title,Days,Times,Location,Max,Instructor,Delivery Mode\n'
    + '202690,TEST 999,Isolated upload,M,1:00 PM - 2:00 PM,CKB 999,10,Test Instructor,Face-to-Face\n';
  const response = await request.post('/api/upload-schedule', {
    multipart: {
      password: server.uploadPassword,
      file: { name: 'fixture-upload.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  // uploaded_schedule_202690.csv is the logical export name. On disk the store
  // keeps immutable payloads named by the manifest it commits alongside them.
  const manifest = JSON.parse(await readFile(path.join(server.directory, '.schedule-manifest.json'), 'utf8'));
  const payload = manifest.records['202690'].payload;
  expect(payload).toMatch(/^\.schedule-data-[a-f0-9]{32}\.csv$/);
  expect(await readFile(path.join(server.directory, payload), 'utf8')).toBe(csv);
  const roster = await (await request.get('/api/rooms/all')).json();
  expect(roster.map(({ building, room }) => `${building} ${room}`)).toEqual(['CKB 999']);
  expect(await scheduleFiles(ROOT)).toEqual(before);
});

test('server exits and removes only its owned directory after forced parent loss', async ({}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'room-finder-browser-'));
  const sibling = await mkdtemp(path.join(tmpdir(), 'room-finder-browser-'));
  const ownerToken = randomBytes(24).toString('hex');
  const configPath = path.join(directory, 'fixture.json');
  await writeFile(path.join(directory, '.fixture-owner'), ownerToken);
  await writeFile(path.join(sibling, 'keep'), 'not owned by the server');
  await writeFile(configPath, JSON.stringify({
    now: FIXED_NOW, schedule: SYNTHETIC_SCHEDULE, ownerToken,
    auth: { adminPassword: 'disposable-admin', uploadPassword: 'disposable-upload' },
  }));
  // This supervisor simulates the Playwright worker that owns the stdin pipe.
  // SIGKILL skips its finally handlers, reproducing the original orphan leak.
  const supervisor = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const { createInterface } = require('node:readline');
    const child = spawn(process.env.ROOM_FINDER_TEST_PYTHON || 'python', ['-u', process.argv[1], process.argv[2]], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.on('error', error => { process.send({ error: error.message }); process.exit(1); });
    child.on('exit', code => process.exit(code ?? 1));
    createInterface({ input: child.stdout }).on('line', line => {
      if (line.startsWith('{')) process.send({ ...JSON.parse(line), pid: child.pid });
    });
  `, path.join(__dirname, 'server.py'), configPath], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let ready;
  let childStopped = false;
  try {
    ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Supervisor startup timeout')), 10_000);
      supervisor.once('error', error => { clearTimeout(timer); reject(error); });
      supervisor.once('exit', code => { clearTimeout(timer); reject(new Error(`Supervisor exited: ${code}`)); });
      supervisor.once('message', message => {
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error));
        else resolve(message);
      });
    });
    expect((await fetch(`${ready.url}/ping`)).status).toBe(200);
    supervisor.kill('SIGKILL');
    await expect.poll(async () => {
      try { await fetch(`${ready.url}/ping`, { signal: AbortSignal.timeout(500) }); return true; }
      catch { return false; }
    }, { timeout: 5_000 }).toBe(false);
    await expect.poll(() => existsSync(directory)).toBe(false);
    await expect.poll(() => {
      try { process.kill(ready.pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    }).toBe(false);
    childStopped = true;
    expect(await readFile(path.join(sibling, 'keep'), 'utf8')).toBe('not owned by the server');
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    if (ready?.pid && !childStopped) {
      try { process.kill(ready.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(directory, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
  }
});

test('server refuses an unowned directory without deleting its files', async ({}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'not-room-finder-owned-'));
  const ownerToken = randomBytes(24).toString('hex');
  try {
    await writeFile(path.join(directory, '.fixture-owner'), ownerToken);
    await writeFile(path.join(directory, 'fixture.json'), JSON.stringify({ ownerToken }));
    const result = spawnSync(process.env.ROOM_FINDER_TEST_PYTHON || 'python', [
      path.join(__dirname, 'server.py'), path.join(directory, 'fixture.json'),
    ], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not fixture-owned');
    expect(await readFile(path.join(directory, '.fixture-owner'), 'utf8')).toBe(ownerToken);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CI initializes runner-local paths through GITHUB_ENV before other steps', async ({}) => {
  const workflow = await readFile(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const jobEnv = workflow.match(/    env:\n([\s\S]*?)    steps:/)[1];
  expect(jobEnv).not.toMatch(/\$\{\{\s*runner\./);
  const initializer = workflow.match(/    steps:\n      - name: Initialize test paths\n        run: \|\n([\s\S]*?)(?=\n      - )/);
  expect(initializer, 'First step must initialize runtime paths').not.toBeNull();
  const directory = await mkdtemp(path.join(tmpdir(), 'room-finder-ci-env-'));
  const githubEnv = path.join(directory, 'github env');
  const runnerTemp = path.join(directory, 'runner temp');
  try {
    const result = spawnSync('/bin/bash', ['-e', '-c', initializer[1]], {
      encoding: 'utf8', env: {
        ...process.env, GITHUB_ENV: githubEnv, RUNNER_TEMP: runnerTemp,
        GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '3',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect((await readFile(githubEnv, 'utf8')).trim().split('\n')).toEqual([
      `VISIT_DB_PATH=${runnerTemp}/unit-visits.sqlite3`,
      `PLAYWRIGHT_OUTPUT_DIR=${runnerTemp}/playwright-42-3`,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('server teardown tolerates a real broken stdin pipe', async ({}) => {
  const child = spawn(process.env.ROOM_FINDER_TEST_PYTHON || 'python', ['-u', '-c',
    'import os, time; os.close(0); print("closed", flush=True); time.sleep(0.5)',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', resolve);
    });
    // Queue a write to the closed read end; EPIPE is emitted asynchronously
    // while stopServer is ending the pipe, just like a teardown race.
    child.stdin.write('probe');
    await stopServer(child);
    expect(child.exitCode).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('server teardown reports stdin errors other than EPIPE', async ({}) => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, exitCode: null, signalCode: null, stdin: new EventEmitter() });
  child.kill = () => { throw new Error('Teardown failed to observe child close'); };
  child.stdin.end = () => queueMicrotask(() => {
    child.stdin.emit('error', Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' }));
    child.exitCode = 0;
    child.emit('exit', 0);
    child.emit('close', 0);
  });
  await expect(stopServer(child)).rejects.toMatchObject({ code: 'EIO' });
});

test('CI report gate rejects skipped, flaky and expected-failure coverage', async ({}) => {
  const workflow = await readFile(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const source = workflow.match(/node - <<'JS'\n([\s\S]*?)\n\s+JS/);
  expect(source, 'CI must execute the JSON report gate').not.toBeNull();
  const directory = await mkdtemp(path.join(tmpdir(), 'room-finder-report-gate-'));
  const passed = {
    errors: [], stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [{ specs: [{ tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] }] }],
  };
  try {
    for (const state of ['passed', 'skipped', 'flaky', 'unexpected', 'expected-failure', 'no-tests']) {
      const report = structuredClone(passed);
      if (['skipped', 'flaky', 'unexpected'].includes(state)) report.stats[state] = 1;
      if (state === 'expected-failure') report.suites[0].specs[0].tests[0].expectedStatus = 'failed';
      if (state === 'no-tests') { report.stats.expected = 0; report.suites = []; }
      await writeFile(path.join(directory, 'results.json'), JSON.stringify(report));
      const result = spawnSync(process.execPath, ['-e', source[1]], {
        env: { ...process.env, PLAYWRIGHT_OUTPUT_DIR: directory }, encoding: 'utf8', timeout: 5_000,
      });
      expect(result.status, `${state}: ${result.stderr}`).toBe(state === 'passed' ? 0 : 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('custom artifact roots isolate traces, HTML and JSON reports', async ({}) => {
  const outputRoot = path.join(tmpdir(), 'room-finder-config-regression');
  const config = JSON.parse(execFileSync(process.execPath, ['-e',
    'process.stdout.write(JSON.stringify(require("./playwright.config.js")))',
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', PLAYWRIGHT_OUTPUT_DIR: outputRoot } }));
  expect(config.outputDir).toBe(path.join(outputRoot, 'artifacts'));
  expect(config.reporter.find(([name]) => name === 'html')[1].outputFolder).toBe(path.join(outputRoot, 'report'));
  expect(config.reporter.find(([name]) => name === 'json')[1].outputFile).toBe(path.join(outputRoot, 'results.json'));
  expect(config.workers).toBeLessThanOrEqual(2);
});

test.describe('fixture options', () => {
  test.use({
    fixtureSchedule: [],
    fixtureNow: '2026-10-06T17:00:00.000Z',
    fixtureAuth: { adminPassword: '', uploadPassword: '' },
    timezoneId: 'America/Los_Angeles',
  });

  test('isolates an empty schedule, disabled auth, and an alternate browser timezone', async ({ page, request, appURL }) => {
    expect(await (await request.get('/api/rooms/all')).json()).toEqual([]);
    expect((await request.get('/admin/visits')).status()).toBe(503);
    await page.goto(appURL);
    expect(await page.evaluate(() => new Date().toISOString())).toBe('2026-10-06T17:00:00.000Z');
    expect(await page.evaluate(() => new Date().getHours())).toBe(10);
    const info = await (await request.get('/api/schedule-info')).json();
    expect(info).toMatchObject({ rooms: 0, entries: 0 });
  });
});

test.describe('public offline shell', () => {
  test.use({ serviceWorkers: 'allow' });

  test('can install the real service worker and reload the public shell offline', async ({ page, context, appURL }) => {
    await page.goto(appURL);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }
      return registration.scope;
    });
    await expect.poll(() => page.evaluate(async () => !!(await caches.match('/')))).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page).toHaveTitle(/NJIT/i);
    await assertScriptOrder(page);
  });
});

