import { Env } from './render.js';

export function checkAuth(request: Request, env: Env): Response | null {
  if (!env.AUTH_TOKEN) {
    return null; // No auth configured
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== env.AUTH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Invalid Bearer token' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return null;
}

function sanitizeSiteId(siteId: string): string {
  if (!siteId || typeof siteId !== 'string') {
    throw new Error('siteId must be a non-empty string');
  }
  const clean = siteId.trim();
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(clean) || clean.includes('..')) {
    throw new Error('Invalid siteId format: only alphanumeric, dash, dot, and underscore allowed');
  }
  return clean;
}

function sanitizeHash(hash: string): string {
  if (!hash || typeof hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hash.trim())) {
    throw new Error('Invalid blob hash: must be a 64-character SHA-256 hexadecimal string');
  }
  return hash.trim().toLowerCase();
}

/**
 * POST /sync/plan
 * Body: { siteId: string, manifest: Record<string, string> }
 * Returns: { missing: string[] }
 */
export async function handleSyncPlan(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let siteId: string;
  try {
    siteId = sanitizeSiteId(body.siteId);
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!body.manifest || typeof body.manifest !== 'object') {
    return new Response(JSON.stringify({ error: 'manifest object is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const manifest = body.manifest as Record<string, string>;
  const uniqueHashes = Array.from(new Set(Object.values(manifest)));

  // Check which hashes already exist in R2 using head()
  // Check in batches of 25 concurrently
  const missing: string[] = [];
  const BATCH_SIZE = 25;

  for (let i = 0; i < uniqueHashes.length; i += BATCH_SIZE) {
    const batch = uniqueHashes.slice(i, i + BATCH_SIZE);
    const checks = await Promise.all(
      batch.map(async (hash) => {
        try {
          const sanitized = sanitizeHash(hash);
          const obj = await env.BLOBS.head(`blobs/${sanitized}`);
          return { hash: sanitized, exists: obj !== null };
        } catch {
          return { hash, exists: false };
        }
      })
    );

    for (const res of checks) {
      if (!res.exists) {
        missing.push(res.hash);
      }
    }
  }

  return new Response(JSON.stringify({ missing, siteId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * PUT /sync/blob/:hash
 * Uploads blob content, decompresses gzip if Content-Encoding is gzip,
 * verifies SHA-256 integrity, and stores in R2.
 */
export async function handleSyncBlob(request: Request, env: Env, rawHash: string): Promise<Response> {
  let hash: string;
  try {
    hash = sanitizeHash(rawHash);
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!request.body) {
    return new Response(JSON.stringify({ error: 'Missing request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let dataStream: ReadableStream = request.body;
  const contentEncoding = request.headers.get('content-encoding')?.toLowerCase();

  if (contentEncoding === 'gzip') {
    dataStream = dataStream.pipeThrough(new DecompressionStream('gzip'));
  }

  const responseBytes = await new Response(dataStream).arrayBuffer();

  // Verify hash
  const computedBuffer = await crypto.subtle.digest('SHA-256', responseBytes);
  const computedHash = Array.from(new Uint8Array(computedBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (computedHash !== hash) {
    return new Response(JSON.stringify({
      error: 'Hash mismatch',
      expected: hash,
      computed: computedHash
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  await env.BLOBS.put(`blobs/${hash}`, responseBytes);

  return new Response(JSON.stringify({ success: true, hash, size: responseBytes.byteLength }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function handleSyncCommit(
  request: Request,
  env: Env,
  userId: string = 'default'
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let siteId: string;
  try {
    siteId = sanitizeSiteId(body.siteId);
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!body.manifest || typeof body.manifest !== 'object') {
    return new Response(JSON.stringify({ error: 'manifest object is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const manifest = body.manifest as Record<string, string>;
  const manifestJson = JSON.stringify(manifest);

  // Write user-scoped manifest
  await env.BLOBS.put(`users/${userId}/sites/${siteId}/manifest.json`, manifestJson, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8'
    }
  });

  // Also write legacy location for default/admin
  if (userId === 'default' || userId === 'admin') {
    await env.BLOBS.put(`sites/${siteId}/manifest.json`, manifestJson, {
      httpMetadata: {
        contentType: 'application/json; charset=utf-8'
      }
    });
  }

  return new Response(JSON.stringify({
    success: true,
    siteId,
    userId,
    fileCount: Object.keys(manifest).length
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
