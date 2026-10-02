#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

function printHelp() {
  console.log(`webshot - upload local static builds to webshot-mcp

Usage:
  webshot sync <distDir> [options]

Options:
  --site <siteId>       Stable site ID (default: hash of git root or current dir)
  --endpoint <url>      webshot-mcp server endpoint (default: env WEBSHOT_ENDPOINT or https://webshot-mcp.bookis.workers.dev)
  --token <token>       Bearer auth token (default: env WEBSHOT_TOKEN)
  -h, --help            Show this help message
`);
}

function findProjectRoot(startDir) {
  let curr = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(curr, '.git'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return process.cwd();
}

function deriveSiteId(targetDir) {
  const root = findProjectRoot(targetDir);
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
  return `site_${hash}`;
}

function walkDir(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) {
    throw new Error(`Directory not found: ${dir}`);
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, baseDir));
    } else if (entry.isFile()) {
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

// Concurrency pool helper for 8-way parallel execution
async function runPool(items, limit, fn) {
  const executing = new Set();
  const results = [];

  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  if (command !== 'sync') {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  let distDir = null;
  let siteId = process.env.WEBSHOT_SITE || null;
  let endpoint = process.env.WEBSHOT_ENDPOINT || 'https://webshot-mcp.bookis.workers.dev';
  let token = process.env.WEBSHOT_TOKEN || null;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--site' && i + 1 < args.length) {
      siteId = args[++i];
    } else if (arg === '--endpoint' && i + 1 < args.length) {
      endpoint = args[++i];
    } else if (arg === '--token' && i + 1 < args.length) {
      token = args[++i];
    } else if (!arg.startsWith('-') && !distDir) {
      distDir = arg;
    }
  }

  if (!distDir) {
    console.error('Error: <distDir> is required');
    process.exit(1);
  }

  const resolvedDist = path.resolve(process.cwd(), distDir);
  if (!fs.existsSync(resolvedDist)) {
    console.error(`Error: Directory does not exist: ${resolvedDist}`);
    process.exit(1);
  }

  if (!siteId) {
    siteId = deriveSiteId(resolvedDist);
  }

  endpoint = endpoint.replace(/\/+$/, '');

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };

  // 1. Walk dist/ and calculate sha256 for each file
  const fileEntries = walkDir(resolvedDist);
  if (fileEntries.length === 0) {
    console.error(`Error: Directory is empty: ${resolvedDist}`);
    process.exit(1);
  }

  const manifest = {};
  const hashToPath = new Map(); // hash -> local full path

  for (const { fullPath, relPath } of fileEntries) {
    const content = fs.readFileSync(fullPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    manifest[relPath] = hash;
    if (!hashToPath.has(hash)) {
      hashToPath.set(hash, fullPath);
    }
  }

  // 2. POST /sync/plan
  const planRes = await fetch(`${endpoint}/sync/plan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ siteId, manifest })
  });

  if (!planRes.ok) {
    const errText = await planRes.text();
    console.error(`Sync plan failed (${planRes.status}): ${errText}`);
    process.exit(1);
  }

  const plan = await planRes.json();
  const missingHashes = Array.isArray(plan.missing) ? plan.missing : [];

  // 3. PUT /sync/blob/<hash> (8-way parallel, gzipped)
  let uploadedBytes = 0;
  if (missingHashes.length > 0) {
    await runPool(missingHashes, 8, async (hash) => {
      const filePath = hashToPath.get(hash);
      if (!filePath) {
        throw new Error(`Local file missing for hash: ${hash}`);
      }
      const rawBytes = fs.readFileSync(filePath);
      const gzipped = zlib.gzipSync(rawBytes);

      const putRes = await fetch(`${endpoint}/sync/blob/${hash}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'gzip',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: gzipped
      });

      if (!putRes.ok) {
        const errText = await putRes.text();
        throw new Error(`Upload blob failed for ${hash} (${putRes.status}): ${errText}`);
      }

      uploadedBytes += gzipped.length;
    });
  }

  // 4. POST /sync/commit
  const commitRes = await fetch(`${endpoint}/sync/commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ siteId, manifest })
  });

  if (!commitRes.ok) {
    const errText = await commitRes.text();
    console.error(`Sync commit failed (${commitRes.status}): ${errText}`);
    process.exit(1);
  }

  // 5. Output exact single summary line
  const totalFiles = Object.keys(manifest).length;
  const uploadedCount = missingHashes.length;
  if (uploadedCount === 0) {
    console.log(`synced 0 files (${totalFiles} unchanged) -> ${siteId}`);
  } else {
    console.log(`synced ${uploadedCount} files -> ${siteId}`);
  }
}

main().catch((err) => {
  console.error(`Sync error: ${err.message}`);
  process.exit(1);
});
