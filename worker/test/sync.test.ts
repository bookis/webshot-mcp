import { describe, it, expect, vi } from 'vitest';
import { handleSyncPlan, handleSyncBlob, handleSyncCommit, checkAuth } from '../src/sync.js';
import zlib from 'node:zlib';

describe('Sync Endpoints', () => {
  it('enforces bearer authentication when AUTH_TOKEN is set', () => {
    const envWithAuth: any = { AUTH_TOKEN: 'secret123' };

    // Missing auth header
    const req1 = new Request('http://localhost/sync/plan', { method: 'POST' });
    const res1 = checkAuth(req1, envWithAuth);
    expect(res1?.status).toBe(401);

    // Wrong token
    const req2 = new Request('http://localhost/sync/plan', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer wrong' }
    });
    const res2 = checkAuth(req2, envWithAuth);
    expect(res2?.status).toBe(403);

    // Correct token
    const req3 = new Request('http://localhost/sync/plan', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer secret123' }
    });
    const res3 = checkAuth(req3, envWithAuth);
    expect(res3).toBeNull();

    // No AUTH_TOKEN set in env -> open
    const envNoAuth: any = {};
    const res4 = checkAuth(req1, envNoAuth);
    expect(res4).toBeNull();
  });

  it('handleSyncPlan correctly identifies missing hashes in R2', async () => {
    const mockR2: any = {
      head: vi.fn(async (key: string) => {
        if (key === 'blobs/1111111111111111111111111111111111111111111111111111111111111111') {
          return { key };
        }
        return null; // missing
      })
    };
    const env: any = { BLOBS: mockR2 };

    const req = new Request('http://localhost/sync/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: 'test-site',
        manifest: {
          'index.html': '1111111111111111111111111111111111111111111111111111111111111111',
          'app.js': '2222222222222222222222222222222222222222222222222222222222222222'
        }
      })
    });

    const res = await handleSyncPlan(req, env);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.missing).toEqual(['2222222222222222222222222222222222222222222222222222222222222222']);
  });

  it('handleSyncBlob verifies hash and decompresses gzipped payload', async () => {
    let savedKey = '';
    let savedBytes: any = null;
    const mockR2: any = {
      put: vi.fn(async (key: string, value: any) => {
        savedKey = key;
        savedBytes = value;
      })
    };
    const env: any = { BLOBS: mockR2 };

    const rawContent = 'Hello World from test blob!';
    const rawBuffer = Buffer.from(rawContent, 'utf-8');
    const hash = 'a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e'; // sha256 of "Hello World"
    // Let's compute actual sha256 of rawContent
    const crypto = await import('node:crypto');
    const actualHash = crypto.createHash('sha256').update(rawBuffer).digest('hex');

    const gzipped = zlib.gzipSync(rawBuffer);

    const req = new Request(`http://localhost/sync/blob/${actualHash}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'gzip'
      },
      body: gzipped
    });

    const res = await handleSyncBlob(req, env, actualHash);
    expect(res.status).toBe(200);
    expect(savedKey).toBe(`blobs/${actualHash}`);
    expect(Buffer.from(savedBytes).toString('utf-8')).toBe(rawContent);
  });

  it('handleSyncCommit writes sites/<siteId>/manifest.json in R2', async () => {
    let savedKey = '';
    let savedJson = '';
    const mockR2: any = {
      put: vi.fn(async (key: string, value: any) => {
        savedKey = key;
        savedJson = value;
      })
    };
    const env: any = { BLOBS: mockR2 };

    const manifest = { 'index.html': 'abc1234' };
    const req = new Request('http://localhost/sync/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: 'my-project',
        manifest
      })
    });

    const res = await handleSyncCommit(req, env);
    expect(res.status).toBe(200);
    expect(savedKey).toBe('sites/my-project/manifest.json');
    expect(JSON.parse(savedJson)).toEqual(manifest);
  });
});
