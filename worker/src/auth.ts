import { Env } from './render.js';

export interface JwtPayload {
  sub: string;
  iat: number;
  exp?: number;
  [key: string]: any;
}

const DEFAULT_SECRET = 'webshot-mcp-default-secret-change-in-production';

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * Signs a payload with HS256 using standard WebCrypto.
 */
export async function signJwt(payload: JwtPayload, secret: string = DEFAULT_SECRET): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = new TextEncoder();

  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const dataToSign = `${headerB64}.${payloadB64}`;

  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(dataToSign));
  const signatureB64 = base64UrlEncode(signature);

  return `${dataToSign}.${signatureB64}`;
}

/**
 * Verifies an HS256 JWT using constant-time WebCrypto verification.
 */
export async function verifyJwt(token: string, secret: string = DEFAULT_SECRET): Promise<JwtPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const dataToVerify = `${headerB64}.${payloadB64}`;

    const enc = new TextEncoder();
    const key = await getHmacKey(secret);
    const signatureBytes = base64UrlDecode(signatureB64);

    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      enc.encode(dataToVerify)
    );

    if (!isValid) return null;

    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    const payload = JSON.parse(payloadJson) as JwtPayload;

    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null; // Expired
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Extracts Bearer token from Authorization header or URL query parameter (?token=...)
 */
export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    return queryToken.trim();
  }

  return null;
}

export function getJwtSecret(env: Env): string {
  if (env.JWT_SECRET) {
    return env.JWT_SECRET;
  }
  // Warn in logs if running with insecure default secret
  console.warn('[auth] SECURITY WARNING: JWT_SECRET is not configured. Set a production secret with: wrangler secret put JWT_SECRET');
  return DEFAULT_SECRET;
}

/**
 * Authenticates the request and extracts the scoped userId.
 * Supports:
 * 1. User JWTs: verified against JWT_SECRET, returns scoped userId from 'sub' claim.
 * 2. Master AUTH_TOKEN: if set, allows admin access with userId = 'admin' (or 'default').
 * 3. Open mode: if neither AUTH_TOKEN nor JWT_SECRET are enforced, defaults to 'default'.
 */
export async function authenticate(
  request: Request,
  env: Env
): Promise<{ userId: string } | Response> {
  const token = extractToken(request);
  const jwtSecret = getJwtSecret(env);

  // 1. If token is provided, attempt JWT verification
  if (token) {
    // Check if it matches master admin token
    if (env.AUTH_TOKEN && token === env.AUTH_TOKEN) {
      return { userId: 'admin' };
    }

    const payload = await verifyJwt(token, jwtSecret);
    if (payload && payload.sub) {
      return { userId: payload.sub };
    }

    return new Response(JSON.stringify({ error: 'Invalid or expired authentication token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 2. If no token provided but AUTH_TOKEN is configured, require authentication
  if (env.AUTH_TOKEN) {
    return new Response(JSON.stringify({
      error: 'Authentication required. Register via POST /auth/register or pass Authorization: Bearer <token>'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 3. Fallback for unauthenticated/open environments
  return { userId: 'default' };
}
