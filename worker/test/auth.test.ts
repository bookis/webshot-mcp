import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt, extractToken, authenticate } from '../src/auth.js';

describe('Auth & JWT Scoping', () => {
  const testSecret = 'test-secret-key-1234567890';

  it('signs and verifies valid JWT payload', async () => {
    const payload = { sub: 'usr_abc123', iat: Math.floor(Date.now() / 1000) };
    const token = await signJwt(payload, testSecret);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);

    const verified = await verifyJwt(token, testSecret);
    expect(verified).not.toBeNull();
    expect(verified?.sub).toBe('usr_abc123');
  });

  it('rejects JWT signed with wrong secret', async () => {
    const token = await signJwt({ sub: 'usr_abc123', iat: Math.floor(Date.now() / 1000) }, testSecret);
    const verified = await verifyJwt(token, 'different-secret');
    expect(verified).toBeNull();
  });

  it('rejects expired JWT', async () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    const token = await signJwt({ sub: 'usr_abc123', iat: past - 50, exp: past }, testSecret);
    const verified = await verifyJwt(token, testSecret);
    expect(verified).toBeNull();
  });

  it('rejects tampered JWT signature', async () => {
    const token = await signJwt({ sub: 'usr_abc123', iat: Math.floor(Date.now() / 1000) }, testSecret);
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.tampered_sig`;
    const verified = await verifyJwt(tampered, testSecret);
    expect(verified).toBeNull();
  });

  it('extracts token from Bearer header and query param', () => {
    const req1 = new Request('http://localhost/mcp', {
      headers: { 'Authorization': 'Bearer my-token-123' }
    });
    expect(extractToken(req1)).toBe('my-token-123');

    const req2 = new Request('http://localhost/mcp?token=query-token-456');
    expect(extractToken(req2)).toBe('query-token-456');

    const req3 = new Request('http://localhost/mcp');
    expect(extractToken(req3)).toBeNull();
  });

  it('authenticates user and returns scoped userId', async () => {
    const env: any = { JWT_SECRET: testSecret };
    const token = await signJwt({ sub: 'usr_xyz789', iat: Math.floor(Date.now() / 1000) }, testSecret);

    const req = new Request('http://localhost/sync/commit', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const result = await authenticate(req, env);
    expect('userId' in result).toBe(true);
    if ('userId' in result) {
      expect(result.userId).toBe('usr_xyz789');
    }
  });

  it('rejects invalid token with 401 response', async () => {
    const env: any = { JWT_SECRET: testSecret };
    const req = new Request('http://localhost/sync/commit', {
      headers: { 'Authorization': 'Bearer bad-token' }
    });

    const result = await authenticate(req, env);
    expect(result instanceof Response).toBe(true);
    if (result instanceof Response) {
      expect(result.status).toBe(401);
    }
  });
});
