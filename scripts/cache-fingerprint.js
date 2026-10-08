#!/usr/bin/env node
'use strict';

// No dependencies or worker execution: fingerprint the explicit local precache,
// the home template, and the worker source with only its version value excluded.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

function requiredFile(root, relative) {
  const filename = path.join(root, relative);
  let resolved;
  try {
    resolved = fs.realpathSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing fingerprint input: ${relative}`);
    throw error;
  }
  if (!resolved.startsWith(`${root}${path.sep}`) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Fingerprint input must be a file inside the project: ${relative}`);
  }
  return fs.readFileSync(resolved);
}

function workerInputs(source) {
  const versions = [...source.matchAll(/^[ \t]*const[ \t]+CACHE_VERSION[ \t]*=[ \t]*(['"])([^'"\r\n]*)\1[ \t]*;/gm)];
  if (versions.length !== 1) throw new Error('Expected exactly one literal CACHE_VERSION declaration');
  const version = versions[0];
  const start = version.index + version[0].indexOf(version[1]) + 1;
  const end = start + version[2].length;
  const declarations = [...source.matchAll(/^[ \t]*const[ \t]+PRECACHE\s*=\s*\[([\s\S]*?)\]\s*;/gm)];
  if (declarations.length !== 1) throw new Error('Expected exactly one literal PRECACHE declaration');
  const urls = [];
  let remaining = declarations[0][1];
  while (remaining.trim()) {
    const item = /^\s*(['"])([^'"\r\n\\]*)\1\s*(,|$)/.exec(remaining);
    if (!item) throw new Error('PRECACHE must be a literal list of local URL strings');
    urls.push(item[2]);
    remaining = remaining.slice(item[0].length);
  }
  if (!urls.includes('/') || new Set(urls).size !== urls.length) {
    throw new Error('PRECACHE must include the public home and contain no duplicate entries');
  }
  for (const url of urls) {
    if (url === '/') continue;
    if (!/^\/static\/[A-Za-z0-9_./-]+$/.test(url)
        || url.slice(1).split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('Invalid precache entry: only / and canonical, query-free /static/ paths are supported');
    }
  }
  return { start, end, current: version[2], urls };
}

function expectedVersion(root, source, inputs) {
  const files = new Map([
    ['static/sw.js', Buffer.from(`${source.slice(0, inputs.start)}<generated-version>${source.slice(inputs.end)}`)],
    ['templates/index.html', requiredFile(root, 'templates/index.html')],
  ]);
  for (const url of inputs.urls) {
    // The worker is already included above with its version normalized.
    if (url !== '/' && url !== '/static/sw.js') files.set(url.slice(1), requiredFile(root, url.slice(1)));
  }
  const hash = createHash('sha256');
  // Length framing makes paths/content boundaries unambiguous. Sorted relative
  // paths, not mtimes or checkout locations, make repeated builds deterministic.
  for (const name of [...files.keys()].sort()) {
    const bytes = files.get(name);
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  return `room-finder-v15-${hash.digest('hex')}`;
}

function replaceVersion(filename, contents) {
  const temporary = `${filename}.fingerprint-${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: fs.statSync(filename).mode });
    fs.chmodSync(temporary, fs.statSync(filename).mode & 0o777);
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function main(args) {
  const usage = 'Usage: node scripts/cache-fingerprint.js (--check|--update) [--root DIRECTORY]';
  let mode;
  let root = path.resolve(__dirname, '..');
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if ((argument === '--check' || argument === '--update') && !mode) mode = argument;
    else if (argument === '--root' && args[index + 1] && !args[index + 1].startsWith('-')) root = path.resolve(args[++index]);
    else throw new Error(usage);
  }
  if (!mode) throw new Error(usage);
  root = fs.realpathSync(root);
  const filename = path.join(root, 'static/sw.js');
  const source = requiredFile(root, 'static/sw.js').toString('utf8');
  const inputs = workerInputs(source);
  const expected = expectedVersion(root, source, inputs);
  if (inputs.current !== expected) {
    if (mode === '--check') {
      throw new Error(`Cache fingerprint is stale: ${inputs.current}\nExpected: ${expected}\nRun npm run update:cache after the final public asset build.`);
    }
    replaceVersion(filename, `${source.slice(0, inputs.start)}${expected}${source.slice(inputs.end)}`);
    console.log(`Updated CACHE_VERSION to ${expected}`);
  } else {
    console.log(`Cache fingerprint is current: ${expected}`);
  }
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
