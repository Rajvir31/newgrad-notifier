// Local job dashboard. `npm run ui` -> http://localhost:8787
//
// Served over HTTP rather than opened as a file:// page on purpose: Chrome gives
// file:// pages an opaque origin, where localStorage throws — and localStorage is
// what remembers which roles you have already applied to.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { fetchAll } from './sources.js';
import { collapse } from './poll.js';
import { needsClearance } from './filter.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(ROOT, 'data/jobs.json');
const PAGE = resolve(ROOT, 'public/app.html');
const PORT = Number(process.env.PORT) || 8787;

// Serving a stale snapshot beats a 5-second blank page on every reload.
const STALE_AFTER = 10 * 60;

let cache = loadCache();
let inFlight = null;

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE, 'utf8'));
  } catch {
    return null;
  }
}

async function refresh() {
  // Collapse a concurrent reload into the one fetch already running, so hitting
  // Refresh twice doesn't pull 44 feeds twice.
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const { jobs, failures, sourceCount } = await fetchAll();
    // No cutoff here — the UI filters by age itself, so you can still dig
    // through older postings that the Slack feed would have skipped.
    const roles = collapse(jobs)
      // Same rule the Slack path uses: this is a US/Canada board, so a role that
      // routes to neither channel (London, Dublin, Bangalore) is not a result.
      .filter((j) => j.channels.length)
      .sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0))
      .map((j) => ({
        id: j.id,
        title: j.title,
        company: j.company,
        locations: j.locations,
        url: j.url,
        postedAt: j.postedAt || 0,
        source: j.source,
        channels: j.channels,
        clearance: needsClearance(j),
      }));
    cache = {
      roles,
      fetchedAt: Math.floor(Date.now() / 1000),
      scanned: jobs.length,
      sourceCount,
      failures: failures.map((f) => f.name),
    };
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache));
    return cache;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/') {
      // Read per request so editing the page just needs a browser reload.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(PAGE));
    }
    if (url.pathname === '/api/jobs') {
      const stale = !cache || Math.floor(Date.now() / 1000) - cache.fetchedAt > STALE_AFTER;
      if (url.searchParams.has('refresh') || stale) await refresh();
      return json(res, 200, cache);
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const at = `http://localhost:${PORT}`;
  console.log(`job board -> ${at}`);
  if (!cache) console.log('no snapshot yet, first load will fetch all 44 feeds (~5s)');
  // Best-effort browser open; a failure here must not take the server down.
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', at]]
    : process.platform === 'darwin' ? ['open', [at]]
    : ['xdg-open', [at]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
});
