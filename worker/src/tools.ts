import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Env, renderPage, loadManifest } from './render.js';
import { listPages } from './resolve.js';

export function registerTools(server: McpServer, env: Env, userId: string = 'default') {
  // Tool 1: screenshot
  server.tool(
    'screenshot',
    'Capture a screenshot of any page on a synced site. Uses Cloudflare Browser Rendering with request interception to serve unreleased builds securely without an origin server.',
    {
      siteId: z.string().describe('Stable site ID (e.g. site_a1b2c3)'),
      path: z.string().describe('Path to screenshot (e.g. / or /pricing or /about)'),
      viewport: z.object({
        width: z.number().optional().describe('Viewport width in pixels (default: 1280)'),
        height: z.number().optional().describe('Viewport height in pixels (default: 800)'),
        deviceScaleFactor: z.number().optional().describe('Device pixel ratio (default: 1, set 2 for retina)')
      }).optional().describe('Optional viewport dimensions'),
      fullPage: z.boolean().optional().describe('Whether to screenshot full scrollable page (default: false)'),
      waitFor: z.union([z.string(), z.number()]).optional().describe('Selector string to wait for, or milliseconds delay'),
      format: z.enum(['jpeg', 'png']).optional().describe('Image format (default: jpeg; png is explicit opt-in)'),
      quality: z.number().min(1).max(100).optional().describe('JPEG quality between 1 and 100 (default: 85)'),
      allowedHosts: z.array(z.string()).optional().describe('Additional external hostnames to permit (e.g. cdn.example.com)')
    },
    async (params) => {
      try {
        const result = await renderPage(env, params.siteId, params.path, {
          viewport: params.viewport,
          fullPage: params.fullPage,
          waitFor: params.waitFor,
          format: params.format,
          quality: params.quality,
          allowedHosts: params.allowedHosts,
          userId
        }, userId);

        const lines: string[] = [
          `Page: ${params.path} (Title: "${result.pageTitle || 'Untitled'}")`,
          `Site: ${params.siteId}`
        ];

        if (result.missing.length > 0) {
          lines.push(`Missing files (${result.missing.length}):\n${result.missing.map((m) => `  - ${m}`).join('\n')}`);
        } else {
          lines.push('Missing files: none (all assets resolved)');
        }

        if (result.errors.length > 0) {
          lines.push(`Errors (${result.errors.length}):\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
        }

        if (result.console.length > 0) {
          lines.push(`Console logs (${result.console.length}):\n${result.console.map((c) => `  [${c.type}] ${c.text}`).join('\n')}`);
        }

        const content: any[] = [];

        if (result.screenshot) {
          content.push({
            type: 'image',
            data: result.screenshot.data,
            mimeType: result.screenshot.mimeType
          });
        }

        content.push({
          type: 'text',
          text: lines.join('\n\n')
        });

        return { content };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Screenshot error: ${(err as Error).message}`
            }
          ]
        };
      }
    }
  );

  // Tool 2: list_pages
  server.tool(
    'list_pages',
    'List all navigable page routes from the site manifest, allowing the agent to discover valid routes instead of guessing.',
    {
      siteId: z.string().describe('Stable site ID (e.g. site_a1b2c3)')
    },
    async ({ siteId }) => {
      try {
        const manifest = await loadManifest(env, siteId, userId);
        if (!manifest) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Site '${siteId}' not found. Run 'npx webshot sync ./dist' first.`
              }
            ]
          };
        }

        const pages = listPages(manifest);
        if (pages.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Site '${siteId}' has ${Object.keys(manifest).length} synced files, but no HTML pages were found.`
              }
            ]
          };
        }

        const text = `Navigable pages for site '${siteId}' (${pages.length} total):\n${pages.map((p) => `  - ${p}`).join('\n')}`;
        return {
          content: [
            {
              type: 'text',
              text
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to list pages for site '${siteId}': ${(err as Error).message}`
            }
          ]
        };
      }
    }
  );

  // Tool 3: console_log
  server.tool(
    'console_log',
    'Diagnose JavaScript errors, runtime console output, and missing network requests for a page without rendering an image.',
    {
      siteId: z.string().describe('Stable site ID (e.g. site_a1b2c3)'),
      path: z.string().describe('Path to inspect (e.g. / or /pricing)'),
      waitFor: z.union([z.string(), z.number()]).optional().describe('Selector string to wait for, or milliseconds delay'),
      allowedHosts: z.array(z.string()).optional().describe('Additional external hostnames to permit')
    },
    async (params) => {
      try {
        const result = await renderPage(env, params.siteId, params.path, {
          skipScreenshot: true,
          waitFor: params.waitFor,
          allowedHosts: params.allowedHosts,
          userId
        }, userId);

        const lines: string[] = [
          `Diagnostics for ${params.path} on site '${params.siteId}' (Title: "${result.pageTitle || 'Untitled'}")`,
          `Secure context: ${result.isSecureContext ? 'yes' : 'no'}`
        ];

        if (result.missing.length > 0) {
          lines.push(`Missing files (${result.missing.length}):\n${result.missing.map((m) => `  - ${m}`).join('\n')}`);
        } else {
          lines.push('Missing files: none (all assets resolved)');
        }

        if (result.errors.length > 0) {
          lines.push(`Page errors (${result.errors.length}):\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
        } else {
          lines.push('Page errors: none');
        }

        if (result.console.length > 0) {
          lines.push(`Console logs (${result.console.length}):\n${result.console.map((c) => `  [${c.type}] ${c.text}`).join('\n')}`);
        } else {
          lines.push('Console logs: none');
        }

        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n\n')
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Diagnostics error: ${(err as Error).message}`
            }
          ]
        };
      }
    }
  );
}
