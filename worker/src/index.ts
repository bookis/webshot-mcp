import { Agent, routeAgentRequest } from 'agents';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Env, renderPage } from './render.js';
import { registerTools } from './tools.js';
import { handleSyncPlan, handleSyncBlob, handleSyncCommit } from './sync.js';
import { authenticate, signJwt, getJwtSecret } from './auth.js';

export { Env };

/**
 * Durable Object implementation of WebshotMcpAgent
 * Inherits stateful features and lifecycle management from Agent
 */
export class WebshotMcpAgent extends Agent<Env> {
  server = new McpServer({
    name: 'webshot-mcp',
    version: '0.1.0'
  });

  async init() {
    registerTools(this.server, this.env);
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version, *',
    'Access-Control-Expose-Headers': '*'
  };
}

function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // 2. Public Registration Endpoint (POST /auth/register or POST /register)
    if ((url.pathname === '/auth/register' || url.pathname === '/register') && request.method === 'POST') {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        // Body is optional
      }

      const randomPart = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const userId = `usr_${randomPart}`;
      const now = Math.floor(Date.now() / 1000);

      // Issue long-lived token (1 year)
      const token = await signJwt({
        sub: userId,
        iat: now,
        exp: now + (365 * 24 * 60 * 60),
        name: body.name || undefined
      }, getJwtSecret(env));

      return withCors(new Response(JSON.stringify({
        success: true,
        userId,
        token,
        endpoint: url.origin,
        instructions: {
          cli: `npx webshot sync ./dist --token ${token}`,
          mcp: {
            url: `${url.origin}/?token=${token}`,
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        }
      }, null, 2), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    // 3. Sync protocol endpoints
    if (url.pathname.startsWith('/sync/')) {
      const authResult = await authenticate(request, env);
      if (authResult instanceof Response) return withCors(authResult);
      const userId = authResult.userId;

      if (url.pathname === '/sync/plan' && request.method === 'POST') {
        const res = await handleSyncPlan(request, env);
        return withCors(res);
      }

      const blobMatch = url.pathname.match(/^\/sync\/blob\/([a-fA-F0-9]{64})$/);
      if (blobMatch && request.method === 'PUT') {
        const res = await handleSyncBlob(request, env, blobMatch[1]);
        return withCors(res);
      }

      if (url.pathname === '/sync/commit' && request.method === 'POST') {
        const res = await handleSyncCommit(request, env, userId);
        return withCors(res);
      }

      return withCors(new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    // 4. Test Render endpoints (diagnostics / sanity checks)
    if (url.pathname === '/test-render') {
      const authResult = await authenticate(request, env);
      if (authResult instanceof Response) return withCors(authResult);
      const userId = authResult.userId;

      try {
        const siteId = url.searchParams.get('site') || 'test-site';
        const path = url.searchParams.get('path') || '/';
        const result = await renderPage(env, siteId, path, { userId }, userId);
        return withCors(new Response(JSON.stringify({
          success: true,
          userId,
          pageTitle: result.pageTitle,
          isSecureContext: result.isSecureContext,
          console: result.console,
          errors: result.errors,
          missing: result.missing,
          screenshotLength: result.screenshot?.data.length,
          mimeType: result.screenshot?.mimeType
        }, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        }));
      } catch (err) {
        return withCors(new Response(JSON.stringify({
          success: false,
          error: (err as Error).message
        }, null, 2), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    if (url.pathname === '/test-render/view') {
      const authResult = await authenticate(request, env);
      if (authResult instanceof Response) return withCors(authResult);
      const userId = authResult.userId;

      try {
        const siteId = url.searchParams.get('site') || 'test-site';
        const path = url.searchParams.get('path') || '/';
        const result = await renderPage(env, siteId, path, { userId }, userId);
        if (!result.screenshot) {
          return withCors(new Response('No screenshot generated', { status: 500 }));
        }
        const imgTag = `<img src="data:${result.screenshot.mimeType};base64,${result.screenshot.data}" style="border:1px solid #ccc; max-width: 100%;" />`;
        const html = `<!DOCTYPE html>
<html>
<head><title>Render Test Result</title></head>
<body style="font-family: sans-serif; padding: 20px;">
  <h2>Render Test Result</h2>
  <p><strong>User:</strong> ${userId}</p>
  <p><strong>Site:</strong> ${siteId}</p>
  <p><strong>Path:</strong> ${path}</p>
  <p><strong>Page Title:</strong> ${result.pageTitle}</p>
  <p><strong>Secure Context:</strong> ${result.isSecureContext}</p>
  <p><strong>Missing:</strong> ${JSON.stringify(result.missing)}</p>
  <p><strong>Console:</strong> <pre>${JSON.stringify(result.console, null, 2)}</pre></p>
  <p><strong>Errors:</strong> <pre>${JSON.stringify(result.errors, null, 2)}</pre></p>
  <h3>Screenshot:</h3>
  ${imgTag}
</body>
</html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      } catch (err) {
        return new Response(`Error: ${(err as Error).message}\n${(err as Error).stack}`, { status: 500 });
      }
    }

    // 5. Agents SDK routing for /agents/*
    if (url.pathname.startsWith('/agents/')) {
      const agentRes = await routeAgentRequest(request, env);
      if (agentRes) return withCors(agentRes);
    }

    // 6. Welcome / status page for browser visits to GET /
    const accept = request.headers.get('accept') || '';
    if (
      request.method === 'GET' &&
      url.pathname === '/' &&
      !accept.includes('text/event-stream') &&
      !accept.includes('application/json')
    ) {
      return withCors(new Response(
        `webshot-mcp server is running.\n\n` +
        `- Connect your MCP client to: ${url.origin}/\n` +
        `- Public registration: POST /auth/register\n` +
        `- Sync static builds via: npx webshot sync ./dist\n` +
        `- Tools provided: screenshot, list_pages, console_log\n`,
        {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }
      ));
    }

    // 7. MCP Streamable HTTP / SSE handling (stateless per-request, user-scoped)
    const authResult = await authenticate(request, env);
    if (authResult instanceof Response) return withCors(authResult);
    const userId = authResult.userId;

    try {
      const server = new McpServer({
        name: 'webshot-mcp',
        version: '0.1.0'
      });
      registerTools(server, env, userId);

      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true
      });
      await server.connect(transport);
      const res = await transport.handleRequest(request);
      return withCors(res);
    } catch (err) {
      return withCors(new Response(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: (err as Error).message
        },
        id: null
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }));
    }
  }
};
