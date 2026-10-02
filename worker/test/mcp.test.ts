import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerTools } from '../src/tools.js';

describe('MCP Server and tools registration', () => {
  it('registers screenshot, list_pages, and console_log tools', async () => {
    const server = new McpServer({
      name: 'webshot-mcp-test',
      version: '0.1.0'
    });

    const mockEnv: any = {
      BLOBS: {
        get: vi.fn(),
        head: vi.fn(),
        put: vi.fn()
      },
      BROWSER: {}
    };

    registerTools(server, mockEnv);

    // Verify tools were registered on underlying server
    const tools = (server as any)._registeredTools;
    expect(tools).toBeDefined();
    expect(tools['list_sites']).toBeDefined();
    expect(tools['screenshot']).toBeDefined();
    expect(tools['list_pages']).toBeDefined();
    expect(tools['console_log']).toBeDefined();
  });

  it('can initialize WebStandardStreamableHTTPServerTransport and answer initialize request', async () => {
    const server = new McpServer({
      name: 'webshot-mcp-test',
      version: '0.1.0'
    });

    const mockEnv: any = {
      BLOBS: {},
      BROWSER: {}
    };
    registerTools(server, mockEnv);

    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true
    });
    await server.connect(transport);

    const initReq = new Request('https://webshot-mcp.local/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      })
    });

    const response = await transport.handleRequest(initReq);
    expect(response.status).toBe(200);

    const body = await response.json() as any;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe('webshot-mcp-test');
    expect(body.result.capabilities.tools).toBeDefined();
  });
});
